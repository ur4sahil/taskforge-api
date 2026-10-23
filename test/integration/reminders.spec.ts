import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createTask } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';
import { RemindersService } from '../../src/modules/reminders/reminders.module';
import { ReminderProcessor } from '../../src/workers/workers.module';
import { dateKeyToDb } from '../../src/common/utils/dates';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

async function setup() {
  const { user, workspace, member, list } = await seedWorkspace();
  const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id });
  return { user, workspace, member, list, task, headers: authHeader(user.id, user.email) };
}

// Seed a reminder row directly for the current member.
async function seedReminder(taskId: string, memberId: string, overrides: any = {}) {
  return prisma().reminder.create({
    data: {
      taskId,
      workspaceMemberId: memberId,
      type: 'exact',
      exactTime: new Date(Date.now() + 3600000),
      nextFireTime: new Date(Date.now() + 3600000),
      ...overrides,
    },
  });
}

describe('Reminders', () => {
  it('creates an exact reminder and sets nextFireTime to exactTime', async () => {
    const { workspace, task, headers } = await setup();
    const when = new Date(Date.now() + 7200000).toISOString();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/reminders`)
      .set(headers)
      .send({ type: 'exact', exactTime: when });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ taskId: task.id, type: 'exact' });
    expect(new Date(res.body.data.nextFireTime).toISOString()).toBe(when);
  });

  it('lists reminders for a task ordered by nextFireTime', async () => {
    const { workspace, member, task, headers } = await setup();
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 7200000) });
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 3600000) });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/reminders`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(new Date(res.body.data[0].nextFireTime).getTime())
      .toBeLessThan(new Date(res.body.data[1].nextFireTime).getTime());
  });

  it('upcoming returns reminders inside the window, excluding fired/dismissed and those beyond it', async () => {
    const { workspace, member, task, headers } = await setup();
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 3600000) });           // in window
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 3600000), isFired: true });    // excluded
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 3600000), isDismissed: true }); // excluded
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 100 * 3600000) });     // beyond window

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reminders/upcoming?hours=48`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].task).toMatchObject({ id: task.id });
  });

  it('calendar returns reminders within the [start,end] range', async () => {
    const { workspace, member, task, headers } = await setup();
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 2 * 86400000) });  // inside
    await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() + 20 * 86400000) }); // outside

    const start = new Date(Date.now()).toISOString();
    const end = new Date(Date.now() + 7 * 86400000).toISOString();
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reminders/calendar?start=${start}&end=${end}`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('suggestions returns only smart-suggestion reminders', async () => {
    const { workspace, member, task, headers } = await setup();
    await seedReminder(task.id, member.id, { isSmartSuggestion: true });
    await seedReminder(task.id, member.id, { isSmartSuggestion: false });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reminders/suggestions`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].isSmartSuggestion).toBe(true);
  });

  it('snooze without an explicit time pushes nextFireTime ~1h out and sets snoozedUntil', async () => {
    const { workspace, member, task, headers } = await setup();
    const r = await seedReminder(task.id, member.id, { nextFireTime: new Date(Date.now() - 1000) });
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/reminders/${r.id}/snooze`)
      .set(headers).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.snoozedUntil).not.toBeNull();
    expect(new Date(res.body.data.nextFireTime).getTime()).toBeGreaterThan(Date.now());
  });

  it('snooze with an explicit until time uses it for both snoozedUntil and nextFireTime', async () => {
    const { workspace, member, task, headers } = await setup();
    const r = await seedReminder(task.id, member.id);
    const until = new Date(Date.now() + 5 * 3600000).toISOString();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/reminders/${r.id}/snooze`)
      .set(headers).send({ until });
    expect(res.status).toBe(201);
    expect(new Date(res.body.data.snoozedUntil).toISOString()).toBe(until);
    expect(new Date(res.body.data.nextFireTime).toISOString()).toBe(until);
  });

  it('dismiss flags the reminder as dismissed', async () => {
    const { workspace, member, task, headers } = await setup();
    const r = await seedReminder(task.id, member.id);
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/reminders/${r.id}/dismiss`)
      .set(headers).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.isDismissed).toBe(true);
  });

  it('update with a new exactTime moves both exactTime and nextFireTime', async () => {
    const { workspace, member, task, headers } = await setup();
    const r = await seedReminder(task.id, member.id);
    const when = new Date(Date.now() + 9 * 3600000).toISOString();
    const res = await request(srv())
      .patch(`/api/v1/workspaces/${workspace.id}/reminders/${r.id}`)
      .set(headers).send({ exactTime: when });
    expect(res.status).toBe(200);
    expect(new Date(res.body.data.nextFireTime).toISOString()).toBe(when);
  });

  it('delete removes the reminder', async () => {
    const { workspace, member, task, headers } = await setup();
    const r = await seedReminder(task.id, member.id);
    const res = await request(srv())
      .delete(`/api/v1/workspaces/${workspace.id}/reminders/${r.id}`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(await prisma().reminder.findUnique({ where: { id: r.id } })).toBeNull();
  });

  it('rejects unauthenticated access with 401', async () => {
    const { workspace, task } = await setup();
    await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/reminders`)
      .expect(401);
  });

  describe('validation', () => {
    const bad: Array<[string, any]> = [
      ['unknown type', { type: 'bogus', exactTime: new Date(Date.now() + 3600000).toISOString() }],
      ['exact without exactTime', { type: 'exact' }],
      ['exact with a non-ISO time', { type: 'exact', exactTime: 'tomorrow' }],
      ['relative without an offset', { type: 'relative' }],
      ['relative with an unknown unit', { type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'weeks' }],
      ['relative with a negative offset', { type: 'relative', relativeOffsetValue: -5, relativeOffsetUnit: 'hours' }],
    ];
    it.each(bad)('rejects %s with 400', async (_n, body) => {
      const { workspace, task, headers } = await setup();
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-10') } });
      const res = await request(srv()).post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/reminders`).set(headers).send(body);
      expect(res.status).toBe(400);
      expect(await prisma().reminder.count()).toBe(0);
    });
  });

  describe('recurring reminders', () => {
    it('are rejected with 400 instead of storing a row that never fires', async () => {
      const { workspace, task, headers } = await setup();
      const res = await request(srv())
        .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/reminders`)
        .set(headers).send({ type: 'recurring' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Recurring reminders are not supported yet');
      expect(await prisma().reminder.count()).toBe(0);
    });
  });

  describe('relative reminders', () => {
    const post = (wid: string, tid: string, headers: any, body: any) =>
      request(srv()).post(`/api/v1/workspaces/${wid}/tasks/${tid}/reminders`).set(headers).send(body);

    it('fire relative to 09:00 on the due day in the workspace timezone (default America/New_York) when the task has no dueTime', async () => {
      const { workspace, task, headers } = await setup();
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-10') } });
      const res = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 2, relativeOffsetUnit: 'hours' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ type: 'relative', relativeOffsetValue: 2, relativeOffsetUnit: 'hours', exactTime: null, isFired: false });
      // 09:00 EDT = 13:00Z, minus 2h.
      expect(new Date(res.body.data.nextFireTime).toISOString()).toBe('2030-06-10T11:00:00.000Z');
    });

    it('use the task dueTime when set, and the offset unit days', async () => {
      const { workspace, task, headers } = await setup();
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-10'), dueTime: '17:30' } });
      const res = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'days' });
      expect(res.status).toBe(201);
      // 17:30 EDT = 21:30Z on Jun 10, minus 1 day.
      expect(new Date(res.body.data.nextFireTime).toISOString()).toBe('2030-06-09T21:30:00.000Z');
    });

    it('honour settings.timezone on the workspace', async () => {
      const { workspace, task, headers } = await setup();
      await prisma().workspace.update({ where: { id: workspace.id }, data: { settings: { timezone: 'Europe/London' } as any } });
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-01-15') } });
      const res = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 30, relativeOffsetUnit: 'minutes' });
      expect(res.status).toBe(201);
      // 09:00 GMT = 09:00Z, minus 30 min.
      expect(new Date(res.body.data.nextFireTime).toISOString()).toBe('2030-01-15T08:30:00.000Z');
    });

    it('stay on the right local time across a DST boundary (due day after spring-forward)', async () => {
      const { workspace, task, headers } = await setup();
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2027-03-15') } }); // DST began 2027-03-14
      const res = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 0, relativeOffsetUnit: 'minutes' });
      expect(new Date(res.body.data.nextFireTime).toISOString()).toBe('2027-03-15T13:00:00.000Z'); // 09:00 EDT
    });

    it('are rejected with 400 when the task has no due date', async () => {
      const { workspace, task, headers } = await setup();
      const res = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'hours' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/no due date/i);
    });

    it('recomputeForTask moves nextFireTime when the due date changes, clears a snooze, and leaves fired/dismissed/exact reminders alone', async () => {
      const { workspace, member, task, headers } = await setup();
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-10') } });
      const rel = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'hours' });
      expect(new Date(rel.body.data.nextFireTime).toISOString()).toBe('2030-06-10T12:00:00.000Z');
      await prisma().reminder.update({ where: { id: rel.body.data.id }, data: { snoozedUntil: new Date('2030-06-10T12:30:00.000Z'), nextFireTime: new Date('2030-06-10T12:30:00.000Z') } });
      const fired = await seedReminder(task.id, member.id, { type: 'relative', exactTime: null, relativeOffsetValue: 1, relativeOffsetUnit: 'hours', isFired: true, nextFireTime: new Date('2030-06-10T12:00:00.000Z') });
      const dismissed = await seedReminder(task.id, member.id, { type: 'relative', exactTime: null, relativeOffsetValue: 1, relativeOffsetUnit: 'hours', isDismissed: true, nextFireTime: new Date('2030-06-10T12:00:00.000Z') });
      const exact = await seedReminder(task.id, member.id, { nextFireTime: new Date('2030-06-01T00:00:00.000Z') });

      // Due date moves two days later and gains a time (the tasks engineer calls this hook).
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-12'), dueTime: '08:00' } });
      const touched = await app.get(RemindersService).recomputeForTask(task.id);
      expect(touched).toBe(1);

      const byId = Object.fromEntries((await prisma().reminder.findMany({})).map(r => [r.id, r]));
      // 08:00 EDT = 12:00Z, minus 1h.
      expect(byId[rel.body.data.id].nextFireTime!.toISOString()).toBe('2030-06-12T11:00:00.000Z');
      expect(byId[rel.body.data.id].snoozedUntil).toBeNull();
      expect(byId[fired.id].nextFireTime!.toISOString()).toBe('2030-06-10T12:00:00.000Z');
      expect(byId[dismissed.id].nextFireTime!.toISOString()).toBe('2030-06-10T12:00:00.000Z');
      expect(byId[exact.id].nextFireTime!.toISOString()).toBe('2030-06-01T00:00:00.000Z');
    });

    it('recomputeForTask clears nextFireTime when the due date is removed, and is a no-op for unknown tasks', async () => {
      const { workspace, task, headers } = await setup();
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-10') } });
      const rel = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'hours' });
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: null } });
      expect(await app.get(RemindersService).recomputeForTask(task.id)).toBe(1);
      expect((await prisma().reminder.findUnique({ where: { id: rel.body.data.id } }))!.nextFireTime).toBeNull();
      expect(await app.get(RemindersService).recomputeForTask('00000000-0000-0000-0000-000000000000')).toBe(0);
    });

    it('PATCH with a new offset recomputes nextFireTime', async () => {
      const { workspace, task, headers } = await setup();
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-10') } });
      const rel = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'hours' });
      const res = await request(srv()).patch(`/api/v1/workspaces/${workspace.id}/reminders/${rel.body.data.id}`).set(headers).send({ relativeOffsetValue: 1, relativeOffsetUnit: 'days' });
      expect(res.status).toBe(200);
      expect(new Date(res.body.data.nextFireTime).toISOString()).toBe('2030-06-09T13:00:00.000Z');
      const bad = await request(srv()).patch(`/api/v1/workspaces/${workspace.id}/reminders/${rel.body.data.id}`).set(headers).send({ relativeOffsetUnit: 'weeks' });
      expect(bad.status).toBe(400);
    });

    it('fire once: the processor marks isFired and a second tick does not refire', async () => {
      const { workspace, member, task, headers } = await setup();
      // Due today with a dueTime far enough in the past that offset 0 is already due.
      const past = new Date(Date.now() - 2 * 3600000);
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb(past.toISOString().slice(0, 10)) } });
      const rel = await post(workspace.id, task.id, headers, { type: 'relative', relativeOffsetValue: 0, relativeOffsetUnit: 'minutes' });
      expect(rel.status).toBe(201);
      // Force it due regardless of the wall clock.
      await prisma().reminder.update({ where: { id: rel.body.data.id }, data: { nextFireTime: new Date(Date.now() - 60000) } });

      const dispatched: any[] = [];
      const stub = { dispatch: async (p: any) => { dispatched.push(p); return { id: 'n' }; } };
      const proc = new ReminderProcessor(prisma() as any, stub as any);
      await proc.process({ name: 'tick', data: {} } as any);
      await proc.process({ name: 'tick', data: {} } as any);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ type: 'reminder', recipientMemberId: member.id, entityId: task.id });
      const after = await prisma().reminder.findUnique({ where: { id: rel.body.data.id } });
      expect(after!.isFired).toBe(true);
      expect(after!.snoozedUntil).toBeNull();
      // Fired reminders are not re-armed by a due-date change.
      await prisma().task.update({ where: { id: task.id }, data: { dueDate: dateKeyToDb('2030-06-10') } });
      expect(await app.get(RemindersService).recomputeForTask(task.id)).toBe(0);
      await proc.process({ name: 'tick', data: {} } as any);
      expect(dispatched).toHaveLength(1);
    });
  });
});
