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
import { todayKey, dateKeyToDb, dbDateToKey, DEFAULT_WORKSPACE_TIMEZONE } from '../../src/common/utils/dates';
import { addDays, addMonthsClamped, parseKey } from '../../src/common/utils/recurrence';

// Overdue is judged by calendar day in the workspace timezone (default
// America/New_York). "Now minus 24h" can still be today there, so build
// yesterday from that calendar instead.
function yesterdayInWorkspaceTz() { return new Date(dateKeyToDb(todayKey(DEFAULT_WORKSPACE_TIMEZONE)).getTime() - 86_400_000); }

const fakeJob = { name: 'tick', data: {} } as any;
class StubNotifications {
  dispatched: any[] = [];
  async dispatch(p: any) { this.dispatched.push(p); return { id: 'n-' + this.dispatched.length } as any; }
}

beforeAll(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });

// Recurrence is calendar-day math in the rule's timezone; these rules use 'UTC'
// so "today" and the stored @db.Date keys share a calendar.
const todayUtc = () => todayKey('UTC');

describe('RecurringTaskProcessor', () => {
  it('fills the 7-day horizon for a daily rule in one tick: one Task + TaskInstance per day, nextOccurrence past the horizon', async () => {
    const { workspace, list, member } = await seedWorkspace();
    // Source task due yesterday; the rule says the next occurrence is today.
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'Daily standup', dueDate: dateKeyToDb(addDays(todayUtc(), -1)) });
    await prisma().recurrenceRule.create({
      data: {
        taskId: parent.id, workspaceId: workspace.id,
        frequency: 'daily' as any, interval: 1,
        nextOccurrence: dateKeyToDb(todayUtc()), isActive: true, timezone: 'UTC',
        endType: 'never' as any,
      },
    });

    const p = new RecurringTaskProcessor(prisma() as any);
    await p.process(fakeJob);

    const instances = await prisma().taskInstance.findMany({ orderBy: { occurrenceDate: 'asc' } });
    expect(instances.map(i => dbDateToKey(i.occurrenceDate))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(d => addDays(todayUtc(), d)));
    const tasks = await prisma().task.findMany({ where: { source: 'recurring' as any } });
    expect(tasks).toHaveLength(8);
    expect(new Set(tasks.map(t => t.title))).toEqual(new Set(['Daily standup']));
    expect(tasks.every(t => t.status === 'todo' && t.listId === list.id && t.creatorId === member.id)).toBe(true);
    const rule = await prisma().recurrenceRule.findFirst({});
    expect(dbDateToKey(rule!.nextOccurrence!)).toBe(addDays(todayUtc(), 8));
    expect(rule!.lastGenerated).not.toBeNull();
    expect(rule!.isActive).toBe(true);
  });

  it('catches up every missed occurrence in one tick (nextOccurrence far in the past)', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: dateKeyToDb(addDays(todayUtc(), -30)) });
    await prisma().recurrenceRule.create({
      data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'daily' as any, interval: 1, nextOccurrence: dateKeyToDb(addDays(todayUtc(), -29)), isActive: true, timezone: 'UTC', endType: 'never' as any },
    });
    await new RecurringTaskProcessor(prisma() as any).process(fakeJob);
    // -29 .. +7 inclusive = 37 occurrences.
    expect(await prisma().taskInstance.count()).toBe(37);
    const rule = await prisma().recurrenceRule.findFirst({});
    expect(dbDateToKey(rule!.nextOccurrence!)).toBe(addDays(todayUtc(), 8));
  });

  it('does not double-generate an occurrence whose TaskInstance already exists (unique index), and leaves no orphan task', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: dateKeyToDb(addDays(todayUtc(), -1)) });
    const due = dateKeyToDb(todayUtc());
    const rule = await prisma().recurrenceRule.create({
      data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'daily' as any, interval: 1, nextOccurrence: due, isActive: true, timezone: 'UTC', endType: 'never' as any },
    });
    await prisma().taskInstance.create({ data: { recurrenceRuleId: rule.id, taskId: parent.id, occurrenceDate: due } });

    await new RecurringTaskProcessor(prisma() as any).process(fakeJob);

    expect(await prisma().taskInstance.count({ where: { occurrenceDate: due } })).toBe(1);
    expect(await prisma().task.count({ where: { source: 'recurring' as any, dueDate: due } })).toBe(0);
    // The rest of the horizon is still filled.
    expect(await prisma().taskInstance.count()).toBe(8);
    expect(await prisma().task.count({ where: { source: 'recurring' as any } })).toBe(7);
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

  it('skips rules whose source task is trashed (archived sources keep going — done tasks auto-archive)', async () => {
    const { workspace, list, member } = await seedWorkspace();
    for (const data of [{ deletedAt: new Date() }]) {
      const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: dateKeyToDb(addDays(todayUtc(), -1)) });
      await prisma().task.update({ where: { id: parent.id }, data });
      await prisma().recurrenceRule.create({
        data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'daily' as any, interval: 1, nextOccurrence: dateKeyToDb(todayUtc()), isActive: true, timezone: 'UTC', endType: 'never' as any },
      });
    }
    await new RecurringTaskProcessor(prisma() as any).process(fakeJob);
    expect(await prisma().taskInstance.count()).toBe(0);
  });

  it('weekly rule: one instance in the horizon, nextOccurrence advances 7 × interval days from the anchor schedule', async () => {
    const { workspace, list, member } = await seedWorkspace();
    // Anchor 13 days ago; every 2 weeks → tomorrow, then 14 days after that.
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: dateKeyToDb(addDays(todayUtc(), -13)) });
    await prisma().recurrenceRule.create({
      data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'weekly' as any, interval: 2, nextOccurrence: dateKeyToDb(addDays(todayUtc(), 1)), isActive: true, timezone: 'UTC', endType: 'never' as any },
    });
    await new RecurringTaskProcessor(prisma() as any).process(fakeJob);
    const instances = await prisma().taskInstance.findMany({});
    expect(instances.map(i => dbDateToKey(i.occurrenceDate))).toEqual([addDays(todayUtc(), 1)]);
    const rule = await prisma().recurrenceRule.findFirst({});
    expect(dbDateToKey(rule!.nextOccurrence!)).toBe(addDays(todayUtc(), 15));
  });

  it('monthly rule advances by whole months on dayOfMonth (clamped), not by setMonth drift', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const occurrence = addDays(todayUtc(), 3);
    const dom = parseKey(occurrence).d;
    const anchor = addMonthsClamped(occurrence, -1, dom);
    const parent = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: dateKeyToDb(anchor) });
    await prisma().recurrenceRule.create({
      data: { taskId: parent.id, workspaceId: workspace.id, frequency: 'monthly' as any, interval: 1, dayOfMonth: dom, nextOccurrence: dateKeyToDb(occurrence), isActive: true, timezone: 'UTC', endType: 'never' as any },
    });
    await new RecurringTaskProcessor(prisma() as any).process(fakeJob);
    const instances = await prisma().taskInstance.findMany({});
    expect(instances.map(i => dbDateToKey(i.occurrenceDate))).toEqual([occurrence]);
    const rule = await prisma().recurrenceRule.findFirst({});
    expect(dbDateToKey(rule!.nextOccurrence!)).toBe(addMonthsClamped(occurrence, 1, dom));
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
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id, dueDate: yesterdayInWorkspaceTz(), title: 'Stale' });

    const stub = new StubNotifications();
    await new OverdueProcessor(prisma() as any, stub as any).process(fakeJob);
    expect(stub.dispatched).toHaveLength(1);
    expect(stub.dispatched[0]).toMatchObject({ channel: 'overdue', type: 'overdue' });
  });

  it('skips overdue tasks with no assignee', async () => {
    const { workspace, list, member } = await seedWorkspace();
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: yesterdayInWorkspaceTz() });
    const stub = new StubNotifications();
    await new OverdueProcessor(prisma() as any, stub as any).process(fakeJob);
    expect(stub.dispatched).toHaveLength(0);
  });

  it('dedupes — does not re-dispatch when an overdue notification already exists today', async () => {
    const { workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id, dueDate: yesterdayInWorkspaceTz() });
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
