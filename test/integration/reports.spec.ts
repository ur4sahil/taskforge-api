import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createUser, addMember, createList, addListMember } from '../fixtures/factories';
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

// ───────────────────────── GET /reports/home ─────────────────────────────────
// Home tiles + rows in one call. Semantics follow GET /tasks (top-level tasks,
// archived/trashed excluded) with calendar-day overdue/due-today in the
// workspace timezone; dueToday counts only open tasks.
describe('Reports — home', () => {
  const home = (wid: string, u: any, scope?: string) =>
    request(srv()).get(`/api/v1/workspaces/${wid}/reports/home${scope ? `?scope=${scope}` : ''}`).set(authHeader(u.id, u.email));

  it('scope=mine (default): counts + ≤10 rows for tasks assigned to the caller, by list rollup', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const other = await createList({ workspaceId: workspace.id, createdById: member.id, name: 'Other' });
    const base = { workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id };
    const t1 = await task({ ...base, status: 'todo', dueDate: dayOffset(-2) });                // overdue
    await task({ ...base, status: 'in_progress', dueDate: dayOffset(-1) });                    // overdue + in progress
    await task({ ...base, status: 'todo', dueDate: todayLocal() });                           // due today
    await task({ ...base, status: 'done', dueDate: todayLocal(), completedAt: daysFromNow(-1) }); // done today → not dueToday, completedThisWeek
    await task({ ...base, listId: other.id, status: 'todo', dueDate: dayOffset(5) });          // open, upcoming, other list
    await task({ ...base, status: 'done', completedAt: daysFromNow(-20) });                   // old completion
    // Noise that must not count: someone else's task, a trashed task, an archived task, a subtask.
    const { user: u2 } = await createUser();
    const m2 = await addMember(workspace.id, u2.id, 'employee');
    await task({ ...base, assigneeId: m2.id, status: 'todo', dueDate: dayOffset(-9) });
    const trashed = await task({ ...base, status: 'todo', dueDate: dayOffset(-9) });
    await prisma().task.update({ where: { id: trashed.id }, data: { deletedAt: new Date() } });
    const archived = await task({ ...base, status: 'todo', dueDate: dayOffset(-9) });
    await prisma().task.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    const child = await task({ ...base, status: 'todo', dueDate: dayOffset(-9) });
    await prisma().task.update({ where: { id: child.id }, data: { parentTaskId: t1.id } });

    const res = await home(workspace.id, user);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.scope).toBe('mine');
    expect(d.counts).toEqual({ open: 4, overdue: 2, dueToday: 1, completedThisWeek: 1, inProgress: 1 });
    expect(d.overdue).toHaveLength(2);
    expect(d.overdue.map((t: any) => t.status)).toEqual(['todo', 'in_progress']); // most overdue first
    expect(d.dueToday).toHaveLength(1);
    expect(d.inProgress).toHaveLength(1);
    // Light select only.
    expect(Object.keys(d.overdue[0]).sort()).toEqual(['assignee', 'dueDate', 'dueTime', 'id', 'list', 'listId', 'priority', 'status', 'title']);
    expect(d.overdue[0].assignee.user.name).toBe('Test User');
    expect(d.overdue[0]).not.toHaveProperty('checklistItems');
    expect(d.byList).toEqual([
      { listId: list.id, name: list.name, openCount: 3 },
      { listId: other.id, name: 'Other', openCount: 1 },
    ]);
  });

  it('caps each row list at 10 while counts report the full total', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const base = { workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id };
    for (let i = 0; i < 13; i++) await task({ ...base, status: 'todo', dueDate: dayOffset(-1 - i) });
    const res = await home(workspace.id, user);
    expect(res.body.data.counts.overdue).toBe(13);
    expect(res.body.data.overdue).toHaveLength(10);
  });

  it('scope=all for an employee is limited to lists they belong to; scope=all for an admin is everything', async () => {
    const { user: adminUser, workspace, member: admin, list: visible } = await seedWorkspace();
    const hidden = await createList({ workspaceId: workspace.id, createdById: admin.id, name: 'Hidden' });
    const { user: empUser } = await createUser();
    const emp = await addMember(workspace.id, empUser.id, 'employee');
    await addListMember(visible.id, emp.id);
    // Assigned to the admin, so scope=mine for the employee sees nothing — scope=all is the list view.
    await task({ workspaceId: workspace.id, listId: visible.id, creatorId: admin.id, assigneeId: admin.id, status: 'todo', dueDate: dayOffset(-1) });
    await task({ workspaceId: workspace.id, listId: hidden.id, creatorId: admin.id, assigneeId: admin.id, status: 'todo', dueDate: dayOffset(-1) });

    const mine = await home(workspace.id, empUser, 'mine');
    expect(mine.body.data.counts).toMatchObject({ open: 0, overdue: 0 });
    const all = await home(workspace.id, empUser, 'all');
    expect(all.body.data.counts).toMatchObject({ open: 1, overdue: 1 });
    expect(all.body.data.overdue.map((t: any) => t.listId)).toEqual([visible.id]);
    expect(all.body.data.byList.map((b: any) => b.listId)).toEqual([visible.id]);

    const adminAll = await home(workspace.id, adminUser, 'all');
    expect(adminAll.body.data.counts).toMatchObject({ open: 2, overdue: 2 });
    expect(adminAll.body.data.byList).toHaveLength(2);
  });

  it('scope=all for a manager includes lists their direct reports are on', async () => {
    const { workspace, member: admin } = await seedWorkspace();
    const { user: mgrUser } = await createUser();
    const mgr = await addMember(workspace.id, mgrUser.id, 'manager');
    const { user: repUser } = await createUser();
    const rep = await addMember(workspace.id, repUser.id, 'employee', mgr.id);
    const repList = await createList({ workspaceId: workspace.id, createdById: admin.id, name: 'Rep list' });
    await addListMember(repList.id, rep.id);
    const unrelated = await createList({ workspaceId: workspace.id, createdById: admin.id, name: 'Unrelated' });
    await task({ workspaceId: workspace.id, listId: repList.id, creatorId: admin.id, assigneeId: rep.id, status: 'in_progress' });
    await task({ workspaceId: workspace.id, listId: unrelated.id, creatorId: admin.id, assigneeId: admin.id, status: 'in_progress' });

    const res = await home(workspace.id, mgrUser, 'all');
    expect(res.body.data.counts).toMatchObject({ open: 1, inProgress: 1 });
    expect(res.body.data.inProgress[0].listId).toBe(repList.id);
  });

  it('an employee with no list memberships gets zeros, not an error', async () => {
    const { workspace } = await seedWorkspace();
    const { user: empUser } = await createUser();
    await addMember(workspace.id, empUser.id, 'employee');
    const res = await home(workspace.id, empUser, 'all');
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ open: 0, overdue: 0, dueToday: 0, completedThisWeek: 0, inProgress: 0 });
    expect(res.body.data.byList).toEqual([]);
  });

  it('judges overdue / due-today against the workspace timezone', async () => {
    const west = 'Etc/GMT+12', east = 'Etc/GMT-14';
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    await prisma().workspace.update({ where: { id: a.workspace.id }, data: { settings: { timezone: east } } });
    await prisma().workspace.update({ where: { id: b.workspace.id }, data: { settings: { timezone: west } } });
    const westToday = dateKeyToDb(todayKey(west));
    await task({ workspaceId: a.workspace.id, listId: a.list.id, creatorId: a.member.id, assigneeId: a.member.id, dueDate: westToday });
    await task({ workspaceId: b.workspace.id, listId: b.list.id, creatorId: b.member.id, assigneeId: b.member.id, dueDate: westToday });
    const ra = await home(a.workspace.id, a.user);
    const rb = await home(b.workspace.id, b.user);
    expect(ra.body.data.counts).toMatchObject({ overdue: 1, dueToday: 0 });
    expect(ra.body.data.overdue).toHaveLength(1);
    expect(rb.body.data.counts).toMatchObject({ overdue: 0, dueToday: 1 });
    expect(rb.body.data.dueToday).toHaveLength(1);
    expect(rb.body.data.today).toBe(todayKey(west));
  });

  it('rejects an unknown scope with 400 and a non-member with 403', async () => {
    const { user, workspace } = await seedWorkspace();
    await home(workspace.id, user, 'everyone').expect(400);
    const { user: stranger } = await createUser();
    await home(workspace.id, stranger).expect(403);
  });
});
