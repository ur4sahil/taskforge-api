// Direct tests for the 5 BullMQ processors. We construct each processor with
// the real Prisma client + a stubbed NotificationsService and call .process(job)
// — no actual queue/Redis involved. This covers the date-math and DB-query
// logic that prod cron jobs depend on.
import {
  RecurringTaskProcessor,
  ReminderProcessor,
  OverdueProcessor,
  AutoArchiveProcessor,
  TrashCleanupProcessor,
} from '../../src/workers/workers.module';
import { prisma, truncateAll, disconnect } from '../fixtures/db';
import { seedWorkspace, createTask } from '../fixtures/factories';

const fakeJob = { name: 'tick', data: {} } as any;
class StubNotifications {
  dispatched: any[] = [];
  async dispatch(p: any) { this.dispatched.push(p); return { id: 'n-' + this.dispatched.length } as any; }
}

beforeAll(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('RecurringTaskProcessor', () => {
  it('generates a Task + TaskInstance for a daily rule whose nextOccurrence is due', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'Daily standup' });
    const due = new Date(Date.now() - 60_000); // already due
    await prisma().recurrenceRule.create({
      data: {
        taskId: parent.id, workspaceId: workspace.id,
        frequency: 'daily' as any, interval: 1,
        nextOccurrence: due, isActive: true, timezone: 'UTC',
        endType: 'never' as any,
      },
    });

    const p = new RecurringTaskProcessor(prisma() as any);
    await p.process(fakeJob);

    const instances = await prisma().taskInstance.findMany({});
    expect(instances).toHaveLength(1);
    const tasks = await prisma().task.findMany({ where: { source: 'recurring' as any } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Daily standup');
    // nextOccurrence advances by exactly one day.
    const rule = await prisma().recurrenceRule.findFirst({});
    const advance = rule!.nextOccurrence!.getTime() - due.getTime();
    expect(advance).toBe(86_400_000);
  });

  it('does not double-generate if a TaskInstance for the same occurrence already exists', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const due = new Date(Date.now() - 60_000);
    const rule = await prisma().recurrenceRule.create({
      data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'daily' as any, interval: 1, nextOccurrence: due, isActive: true, timezone: 'UTC', endType: 'never' as any },
    });
    await prisma().taskInstance.create({ data: { recurrenceRuleId: rule.id, taskId: parent.id, occurrenceDate: due } });

    const p = new RecurringTaskProcessor(prisma() as any);
    await p.process(fakeJob);

    expect(await prisma().task.count({ where: { source: 'recurring' as any } })).toBe(0);
    expect(await prisma().taskInstance.count()).toBe(1);
  });

  it('skips inactive rules entirely', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().recurrenceRule.create({
      data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'daily' as any, interval: 1, nextOccurrence: new Date(Date.now() - 60_000), isActive: false, timezone: 'UTC', endType: 'never' as any },
    });
    await new RecurringTaskProcessor(prisma() as any).process(fakeJob);
    expect(await prisma().taskInstance.count()).toBe(0);
  });

  it('weekly rule advances nextOccurrence by 7 × interval days', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const due = new Date('2026-05-01T09:00:00Z');
    await prisma().recurrenceRule.create({
      data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'weekly' as any, interval: 2, nextOccurrence: due, isActive: true, timezone: 'UTC', endType: 'never' as any },
    });
    await new RecurringTaskProcessor(prisma() as any).process(fakeJob);
    const rule = await prisma().recurrenceRule.findFirst({});
    // 2 weeks = 14 days
    expect(rule!.nextOccurrence!.getTime() - due.getTime()).toBe(14 * 86_400_000);
  });
});

describe('ReminderProcessor', () => {
  it('fires only reminders whose nextFireTime has passed, marks isFired=true, dispatches notification', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: new Date(Date.now() + 30 * 60_000) });
    const dueReminder = await prisma().reminder.create({
      data: { taskId: task.id, workspaceMemberId: member.id, type: 'exact' as any, exactTime: new Date(Date.now() - 60_000), nextFireTime: new Date(Date.now() - 60_000), isFired: false, isDismissed: false },
    });
    const futureReminder = await prisma().reminder.create({
      data: { taskId: task.id, workspaceMemberId: member.id, type: 'exact' as any, exactTime: new Date(Date.now() + 3600_000), nextFireTime: new Date(Date.now() + 3600_000), isFired: false, isDismissed: false },
    });

    const stub = new StubNotifications();
    await new ReminderProcessor(prisma() as any, stub as any).process(fakeJob);

    const after = await prisma().reminder.findMany({});
    const byId = Object.fromEntries(after.map(r => [r.id, r]));
    expect(byId[dueReminder.id].isFired).toBe(true);
    expect(byId[futureReminder.id].isFired).toBe(false);
    expect(stub.dispatched).toHaveLength(1);
    expect(stub.dispatched[0]).toMatchObject({
      channel: 'reminder', type: 'reminder', entityType: 'task', entityId: task.id,
      recipientMemberId: member.id, workspaceId: workspace.id,
    });
  });

  it('skips dismissed reminders even if past nextFireTime', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().reminder.create({
      data: { taskId: task.id, workspaceMemberId: member.id, type: 'exact' as any, nextFireTime: new Date(Date.now() - 60_000), isFired: false, isDismissed: true },
    });
    const stub = new StubNotifications();
    await new ReminderProcessor(prisma() as any, stub as any).process(fakeJob);
    expect(stub.dispatched).toHaveLength(0);
  });
});

describe('OverdueProcessor', () => {
  it('dispatches once per overdue task with an assignee', async () => {
    const { workspace, list, member } = await seedWorkspace();
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id, dueDate: new Date(Date.now() - 86_400_000), title: 'Stale' });

    const stub = new StubNotifications();
    await new OverdueProcessor(prisma() as any, stub as any).process(fakeJob);
    expect(stub.dispatched).toHaveLength(1);
    expect(stub.dispatched[0]).toMatchObject({ channel: 'overdue', type: 'overdue' });
  });

  it('skips overdue tasks with no assignee', async () => {
    const { workspace, list, member } = await seedWorkspace();
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: new Date(Date.now() - 86_400_000) });
    const stub = new StubNotifications();
    await new OverdueProcessor(prisma() as any, stub as any).process(fakeJob);
    expect(stub.dispatched).toHaveLength(0);
  });

  it('dedupes — does not re-dispatch when an overdue notification already exists today', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id, dueDate: new Date(Date.now() - 86_400_000) });
    await prisma().notification.create({
      data: {
        workspaceId: workspace.id, recipientId: member.id, type: 'overdue',
        title: 'old', body: 'old', data: { entityId: task.id } as any,
      },
    });
    const stub = new StubNotifications();
    await new OverdueProcessor(prisma() as any, stub as any).process(fakeJob);
    expect(stub.dispatched).toHaveLength(0);
  });
});

describe('AutoArchiveProcessor', () => {
  it('archives "done" tasks older than workspace.settings.autoArchiveDays', async () => {
    const { workspace, list, member } = await seedWorkspace();
    // Default seed sets autoArchiveDays: 30. Make a 31-day-old completed task.
    const oldDone = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, status: 'done' });
    await prisma().task.update({ where: { id: oldDone.id }, data: { completedAt: new Date(Date.now() - 31 * 86_400_000) } });
    const recentDone = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, status: 'done' });
    await prisma().task.update({ where: { id: recentDone.id }, data: { completedAt: new Date(Date.now() - 5 * 86_400_000) } });

    await new AutoArchiveProcessor(prisma() as any).process(fakeJob);

    const old = await prisma().task.findUnique({ where: { id: oldDone.id } });
    const recent = await prisma().task.findUnique({ where: { id: recentDone.id } });
    expect(old!.archivedAt).not.toBeNull();
    expect(recent!.archivedAt).toBeNull();
  });

  it('respects per-workspace autoArchiveDays override', async () => {
    const { workspace, list, member } = await seedWorkspace();
    await prisma().workspace.update({ where: { id: workspace.id }, data: { settings: { autoArchiveDays: 7 } as any } });
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, status: 'done' });
    await prisma().task.update({ where: { id: task.id }, data: { completedAt: new Date(Date.now() - 10 * 86_400_000) } });

    await new AutoArchiveProcessor(prisma() as any).process(fakeJob);

    const after = await prisma().task.findUnique({ where: { id: task.id } });
    expect(after!.archivedAt).not.toBeNull();
  });
});

describe('TrashCleanupProcessor', () => {
  it('hard-deletes tasks soft-deleted longer than workspace.settings.trashRetentionDays', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const oldTrash = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().task.update({ where: { id: oldTrash.id }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
    const recentTrash = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().task.update({ where: { id: recentTrash.id }, data: { deletedAt: new Date(Date.now() - 5 * 86_400_000) } });

    await new TrashCleanupProcessor(prisma() as any).process(fakeJob);

    expect(await prisma().task.findUnique({ where: { id: oldTrash.id } })).toBeNull();
    expect(await prisma().task.findUnique({ where: { id: recentTrash.id } })).not.toBeNull();
  });
});
