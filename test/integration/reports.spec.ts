import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createUser, addMember, createList } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';
import { todayKey, dateKeyToDb, DEFAULT_WORKSPACE_TIMEZONE } from '../../src/common/utils/dates';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

// Due dates are calendar days in the workspace's timezone (default
// America/New_York). Build them from that day, never from Date.now() instants.
function dayOffset(n: number, tz = DEFAULT_WORKSPACE_TIMEZONE) {
  return new Date(dateKeyToDb(todayKey(tz)).getTime() + n * 86400000);
}
function daysFromNow(n: number) { return new Date(Date.now() + n * 86400000); }
function todayLocal() { return dayOffset(0); }

// Create a task with full control over status / dueDate / completedAt / assignee.
async function task(opts: { workspaceId: string; listId: string; creatorId: string; assigneeId: string; status?: string; dueDate?: Date; completedAt?: Date }) {
  return prisma().task.create({
    data: {
      workspaceId: opts.workspaceId,
      listId: opts.listId,
      creatorId: opts.creatorId,
      assigneeId: opts.assigneeId,
      title: 'T',
      status: (opts.status || 'todo') as any,
      dueDate: opts.dueDate ?? null,
      completedAt: opts.completedAt ?? null,
    },
  });
}

describe('Reports — my-stats', () => {
  it('counts open / overdue / dueToday / completedThisWeek for the current member', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const base = { workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id };

    await task({ ...base, status: 'todo', dueDate: dayOffset(3) });                          // open, not overdue
    await task({ ...base, status: 'in_progress', dueDate: dayOffset(-3) });                   // open + overdue
    await task({ ...base, status: 'todo', dueDate: todayLocal() });                          // open + dueToday
    await task({ ...base, status: 'done', completedAt: daysFromNow(-2) });                   // completed this week
    await task({ ...base, status: 'done', completedAt: daysFromNow(-20) });                  // completed, but >7d ago

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reports/my-stats`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ open: 3, overdue: 1, dueToday: 1, completedThisWeek: 1 });
  });

  // Two workspaces 26 hours apart always disagree on what day it is, so the
  // same calendar date is "today" in one and "yesterday"/"tomorrow" in the other.
  it('judges overdue / due-today against the workspace timezone, not UTC', async () => {
    const west = 'Etc/GMT+12'; // UTC-12
    const east = 'Etc/GMT-14'; // UTC+14
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    await prisma().workspace.update({ where: { id: a.workspace.id }, data: { settings: { timezone: east } } });
    await prisma().workspace.update({ where: { id: b.workspace.id }, data: { settings: { timezone: west } } });

    // A task due on the western workspace's "today": that day is already over in the east.
    const westToday = dateKeyToDb(todayKey(west));
    await task({ workspaceId: a.workspace.id, listId: a.list.id, creatorId: a.member.id, assigneeId: a.member.id, dueDate: westToday });
    await task({ workspaceId: b.workspace.id, listId: b.list.id, creatorId: b.member.id, assigneeId: b.member.id, dueDate: westToday });

    const ra = await request(srv()).get(`/api/v1/workspaces/${a.workspace.id}/reports/my-stats`).set(authHeader(a.user.id, a.user.email));
    const rb = await request(srv()).get(`/api/v1/workspaces/${b.workspace.id}/reports/my-stats`).set(authHeader(b.user.id, b.user.email));
    expect(ra.body.data).toMatchObject({ overdue: 1, dueToday: 0 });
    expect(rb.body.data).toMatchObject({ overdue: 0, dueToday: 1 });
  });

  it('a task due today is not overdue, whatever the hour', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    await task({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id, dueDate: todayLocal() });
    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/reports/my-stats`).set(authHeader(user.id, user.email));
    expect(res.body.data).toMatchObject({ open: 1, overdue: 0, dueToday: 1 });
  });

  it('excludes soft-deleted tasks from counts', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const t = await task({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id, status: 'todo' });
    await prisma().task.update({ where: { id: t.id }, data: { deletedAt: new Date() } });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reports/my-stats`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data.open).toBe(0);
  });
});

describe('Reports — team', () => {
  it('a manager sees stats for their direct reports only', async () => {
    const { workspace } = await seedWorkspace();
    const { user: mgrUser } = await createUser({ name: 'Mgr' });
    const mgr = await addMember(workspace.id, mgrUser.id, 'manager');
    const { user: repUser } = await createUser({ name: 'Report' });
    const rep = await addMember(workspace.id, repUser.id, 'employee', mgr.id);
    const { user: otherUser } = await createUser({ name: 'NotMine' });
    await addMember(workspace.id, otherUser.id, 'employee'); // no manager

    const list = await createList({ workspaceId: workspace.id, createdById: mgr.id });
    await task({ workspaceId: workspace.id, listId: list.id, creatorId: mgr.id, assigneeId: rep.id, status: 'todo' });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reports/team`)
      .set(authHeader(mgrUser.id, mgrUser.email));
    expect(res.status).toBe(200);
    expect(res.body.data.teamSize).toBe(1);
    expect(res.body.data.members).toHaveLength(1);
    expect(res.body.data.members[0]).toMatchObject({ name: 'Report', open: 1 });
  });

  it('an employee is forbidden from the team report (403)', async () => {
    const { workspace } = await seedWorkspace();
    const { user: emp } = await createUser();
    await addMember(workspace.id, emp.id, 'employee');
    await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reports/team`)
      .set(authHeader(emp.id, emp.email))
      .expect(403);
  });
});

describe('Reports — workspace', () => {
  it('an admin gets workspace-wide totals and a status breakdown', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const base = { workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id };
    await task({ ...base, status: 'todo' });
    await task({ ...base, status: 'todo', dueDate: dayOffset(-1) }); // overdue
    await task({ ...base, status: 'done' });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reports/workspace`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 3, open: 2, overdue: 1 });
    const statusMap = Object.fromEntries(res.body.data.byStatus.map((b: any) => [b.status, b._count]));
    expect(statusMap.todo).toBe(2);
    expect(statusMap.done).toBe(1);
  });

  it('a manager is forbidden from the workspace report (403)', async () => {
    const { workspace } = await seedWorkspace();
    const { user: mgr } = await createUser();
    await addMember(workspace.id, mgr.id, 'manager');
    await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/reports/workspace`)
      .set(authHeader(mgr.id, mgr.email))
      .expect(403);
  });
});
