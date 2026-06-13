import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createTask } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';

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
});
