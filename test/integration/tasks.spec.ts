import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, createWorkspace, addMember, createList, createTask, addListMember } from '../fixtures/factories';
import { todayKey, dateKeyToDb, dbDateToKey } from '../../src/common/utils/dates';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('Tasks', () => {
  it('POST creates a task in a list (status defaults to todo, priority medium)', async () => {
    const { user, workspace, list } = await seedWorkspace();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/lists/${list.id}/tasks`)
      .set(authHeader(user.id, user.email))
      .send({ title: 'My first task' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'My first task',
      status: 'todo',
      priority: 'medium',
      workspaceId: workspace.id,
      listId: list.id,
    });
  });

  it('GET workspace tasks lists with pagination meta', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    for (let i = 0; i < 3; i += 1) {
      await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: `T${i}` });
    }
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/tasks`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
    expect(res.body.meta).toMatchObject({ total: 3, page: 1 });
  });

  it('GET single task includes checklist items', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().checklistItem.create({ data: { taskId: task.id, text: 'step 1', sortOrder: 0 } });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.checklistItems).toHaveLength(1);
    expect(res.body.data.checklistItems[0].text).toBe('step 1');
  });

  it('PATCH updates title and description', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(user.id, user.email))
      .send({ title: 'Updated', description: 'Now with description' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Updated');
    expect(res.body.data.description).toBe('Now with description');
  });

  it('PATCH status=done sets completedAt; status=todo clears it', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const done = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(user.id, user.email))
      .send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('done');
    expect(done.body.data.completedAt).not.toBeNull();

    const back = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(user.id, user.email))
      .send({ status: 'todo' });
    expect(back.status).toBe(200);
    expect(back.body.data.completedAt).toBeNull();
  });

  it('DELETE soft-deletes (sets deletedAt)', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    const row = await prisma().task.findUnique({ where: { id: task.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
  });

  it('POST /:tid/lock as admin works; as employee returns 403', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    await addMember(workspace.id, emp.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id });

    const empLock = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/lock`)
      .set(authHeader(emp.id, emp.email));
    expect(empLock.status).toBe(403);

    const adminLock = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/lock`)
      .set(authHeader(admin.id, admin.email));
    expect(adminLock.status).toBe(201);
    expect(adminLock.body.data.isLocked).toBe(true);
  });

  it('locked task: non-admin PATCH content returns 403', async () => {
    const { workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    // Task created by employee so they would normally be able to edit.
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: empMember.id });
    await prisma().task.update({ where: { id: task.id }, data: { isLocked: true, lockedById: adminMember.id, lockedAt: new Date() } });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(emp.id, emp.email))
      .send({ title: 'try' });
    expect(res.status).toBe(403);
  });

  it('admin PATCH on a locked task still works', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id });
    await prisma().task.update({ where: { id: task.id }, data: { isLocked: true, lockedById: adminMember.id, lockedAt: new Date() } });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(admin.id, admin.email))
      .send({ title: 'Admin override' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Admin override');
  });

  it('assignee can change status even when locked (per permissions rules)', async () => {
    const { workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const task = await createTask({
      workspaceId: workspace.id, listId: list.id,
      creatorId: adminMember.id, assigneeId: empMember.id,
    });
    await prisma().task.update({ where: { id: task.id }, data: { isLocked: true } });

    // Locked && status-only change: assignee can change status per getTaskPermissions.canChangeStatus
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(emp.id, emp.email))
      .send({ status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');
  });

  it('checklist: add, toggle, delete', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const a = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/checklist`)
      .set(authHeader(user.id, user.email))
      .send({ text: 'first' });
    expect(a.status).toBe(201);
    const b = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/checklist`)
      .set(authHeader(user.id, user.email))
      .send({ text: 'second' });
    expect(b.status).toBe(201);

    const aId = a.body.data.id;

    const toggle = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/checklist/${aId}`)
      .set(authHeader(user.id, user.email))
      .send({ isChecked: true });
    expect(toggle.status).toBe(200);
    expect(toggle.body.data.isChecked).toBe(true);

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/checklist/${aId}`)
      .set(authHeader(user.id, user.email));
    expect(del.status).toBe(200);
    const after = await prisma().checklistItem.findMany({ where: { taskId: task.id } });
    expect(after).toHaveLength(1);
  });

  it('checklist reorder via HTTP swaps sortOrder', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const a = await prisma().checklistItem.create({ data: { taskId: task.id, text: 'A', sortOrder: 0 } });
    const b = await prisma().checklistItem.create({ data: { taskId: task.id, text: 'B', sortOrder: 1 } });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/checklist/reorder`)
      .set(authHeader(user.id, user.email))
      .send({ itemIds: [b.id, a.id] });
    expect(res.status).toBe(200);
    const ordered = await prisma().checklistItem.findMany({ where: { taskId: task.id }, orderBy: { sortOrder: 'asc' } });
    expect(ordered.map(i => i.id)).toEqual([b.id, a.id]);
  });
});

// ───────────────────────── Archive ─────────────────────────
const ws = (id: string) => `/api/v1/workspaces/${id}`;
const shiftKey = (key: string, days: number) => dbDateToKey(new Date(dateKeyToDb(key).getTime() + days * 86400000));

describe('Tasks — archive', () => {
  it('archived tasks are hidden from GET /tasks and GET /lists/:lid/tasks; ?archived=1 lists only them', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const live = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'live' });
    const archived = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'archived', status: 'done', archivedAt: new Date() });
    // Archived AND trashed: must show in neither view (trash owns it).
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'archived+trashed', archivedAt: new Date() })
      .then(t => prisma().task.update({ where: { id: t.id }, data: { deletedAt: new Date() } }));

    const all = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks`).set(authHeader(user.id, user.email));
    expect(all.status).toBe(200);
    expect(all.body.data.map((t: any) => t.id)).toEqual([live.id]);
    expect(all.body.meta.total).toBe(1);

    const byList = await request(app.getHttpServer()).get(`${ws(workspace.id)}/lists/${list.id}/tasks`).set(authHeader(user.id, user.email));
    expect(byList.body.data.map((t: any) => t.id)).toEqual([live.id]);

    const arch = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?archived=1`).set(authHeader(user.id, user.email));
    expect(arch.status).toBe(200);
    expect(arch.body.data.map((t: any) => t.id)).toEqual([archived.id]);

    const archByList = await request(app.getHttpServer()).get(`${ws(workspace.id)}/lists/${list.id}/tasks?archived=true`).set(authHeader(user.id, user.email));
    expect(archByList.body.data.map((t: any) => t.id)).toEqual([archived.id]);

    // ?archived=0 is the default view, not "everything".
    const zero = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?archived=0`).set(authHeader(user.id, user.email));
    expect(zero.body.data.map((t: any) => t.id)).toEqual([live.id]);
  });

  it('POST /archive sets archivedAt on a todo task (any status allowed); POST /unarchive clears it', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, status: 'todo' });

    const arch = await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${task.id}/archive`).set(authHeader(user.id, user.email));
    expect(arch.status).toBe(201);
    expect(arch.body.data.archivedAt).not.toBeNull();
    expect(arch.body.data.status).toBe('todo');
    expect((await prisma().task.findUnique({ where: { id: task.id } }))!.archivedAt).not.toBeNull();

    const un = await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${task.id}/unarchive`).set(authHeader(user.id, user.email));
    expect(un.status).toBe(201);
    expect(un.body.data.archivedAt).toBeNull();
    expect((await prisma().task.findUnique({ where: { id: task.id } }))!.archivedAt).toBeNull();
  });

  it('archive/unarchive need canFullEdit: assignee-only employee 403, stranger 403, creator ok, admin ok; trashed task 400', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const { user: stranger } = await createUser();
    await addMember(workspace.id, stranger.id, 'employee');

    // Assigned to emp, created by admin → emp can change status but not fully edit.
    const assigned = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id, assigneeId: empMember.id });
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${assigned.id}/archive`).set(authHeader(emp.id, emp.email))).status).toBe(403);
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${assigned.id}/archive`).set(authHeader(stranger.id, stranger.email))).status).toBe(403);
    expect((await prisma().task.findUnique({ where: { id: assigned.id } }))!.archivedAt).toBeNull();

    // Creator employee can archive + unarchive their own.
    const own = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: empMember.id });
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${own.id}/archive`).set(authHeader(emp.id, emp.email))).status).toBe(201);
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${own.id}/unarchive`).set(authHeader(stranger.id, stranger.email))).status).toBe(403);
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${own.id}/unarchive`).set(authHeader(emp.id, emp.email))).status).toBe(201);

    // Admin can archive anything.
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${assigned.id}/archive`).set(authHeader(admin.id, admin.email))).status).toBe(201);

    // Trashed task cannot be archived.
    const trashed = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id });
    await prisma().task.update({ where: { id: trashed.id }, data: { deletedAt: new Date() } });
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/${trashed.id}/archive`).set(authHeader(admin.id, admin.email))).status).toBe(400);

    // Unknown task → 404.
    expect((await request(app.getHttpServer()).post(`${ws(workspace.id)}/tasks/00000000-0000-4000-8000-000000000000/archive`).set(authHeader(admin.id, admin.email))).status).toBe(404);
  });
});

// ───────────────────────── PATCH: move + time fields + validation ─────────────────────────
describe('Tasks — PATCH listId / times / validation', () => {
  it('PATCH listId moves the task and its subtasks to another list in the workspace', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const target = await createList({ workspaceId: workspace.id, createdById: member.id, name: 'target' });
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const sub = await prisma().task.create({ data: { workspaceId: workspace.id, listId: list.id, creatorId: member.id, parentTaskId: task.id, title: 'sub' } });

    const res = await request(app.getHttpServer())
      .patch(`${ws(workspace.id)}/tasks/${task.id}`)
      .set(authHeader(user.id, user.email))
      .send({ listId: target.id });
    expect(res.status).toBe(200);
    expect(res.body.data.listId).toBe(target.id);
    expect(res.body.data.list).toEqual({ id: target.id, name: 'target' });
    expect((await prisma().task.findUnique({ where: { id: sub.id } }))!.listId).toBe(target.id);
  });

  it('PATCH listId to a list in another workspace → 404, task unchanged', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const { user: other } = await createUser();
    const { workspace: otherWs, member: otherMember } = await createWorkspace({ ownerUserId: other.id });
    const foreign = await createList({ workspaceId: otherWs.id, createdById: otherMember.id });
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const res = await request(app.getHttpServer())
      .patch(`${ws(workspace.id)}/tasks/${task.id}`)
      .set(authHeader(user.id, user.email))
      .send({ listId: foreign.id });
    expect(res.status).toBe(404);
    expect((await prisma().task.findUnique({ where: { id: task.id } }))!.listId).toBe(list.id);
  });

  it('PATCH listId to a same-workspace list the employee cannot access → 403; after being added → 200', async () => {
    const { workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    await addListMember(list.id, empMember.id, adminMember.id);
    const hidden = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'hidden' });
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: empMember.id });

    const denied = await request(app.getHttpServer())
      .patch(`${ws(workspace.id)}/tasks/${task.id}`)
      .set(authHeader(emp.id, emp.email))
      .send({ listId: hidden.id });
    expect(denied.status).toBe(403);
    expect((await prisma().task.findUnique({ where: { id: task.id } }))!.listId).toBe(list.id);

    await addListMember(hidden.id, empMember.id, adminMember.id);
    const ok = await request(app.getHttpServer())
      .patch(`${ws(workspace.id)}/tasks/${task.id}`)
      .set(authHeader(emp.id, emp.email))
      .send({ listId: hidden.id });
    expect(ok.status).toBe(200);
    expect(ok.body.data.listId).toBe(hidden.id);
  });

  it('PATCH dueTime/startTime/timezone: valid values stored, null clears, bad values 400', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const h = authHeader(user.id, user.email);

    const ok = await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h)
      .send({ dueDate: '2026-11-01', dueTime: '17:30', startTime: '09:00', timezone: 'America/Chicago' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ dueTime: '17:30', startTime: '09:00', timezone: 'America/Chicago' });

    const cleared = await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h)
      .send({ dueTime: null, startTime: null, timezone: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ dueTime: null, startTime: null, timezone: null });

    for (const bad of [{ dueTime: '5:30' }, { dueTime: '24:00' }, { dueTime: '17:60' }, { dueTime: '5pm' }, { startTime: '1730' }, { timezone: 'Mars/Olympus' }, { timezone: '' }]) {
      const res = await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send(bad);
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
    }
    // Boundary values of the HH:MM range are accepted.
    const edge = await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ dueTime: '00:00', startTime: '23:59' });
    expect(edge.status).toBe(200);
  });

  it('PATCH with invalid status / priority / assigneeId → 400 (not 500); null assigneeId unassigns', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, assigneeId: member.id });
    const h = authHeader(user.id, user.email);

    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ status: 'finished' })).status).toBe(400);
    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ priority: 'asap' })).status).toBe(400);
    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ assigneeId: 'not-a-uuid' })).status).toBe(400);
    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ listId: 'nope' })).status).toBe(400);
    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ title: 'x'.repeat(256) })).status).toBe(400);

    const un = await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ assigneeId: null });
    expect(un.status).toBe(200);
    expect(un.body.data.assigneeId).toBeNull();

    const valid = await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ status: 'waiting_for', priority: 'urgent' });
    expect(valid.status).toBe(200);
    expect(valid.body.data).toMatchObject({ status: 'waiting_for', priority: 'urgent' });
  });

  it('POST create with invalid priority / dueTime / timezone → 400', async () => {
    const { user, workspace, list } = await seedWorkspace();
    const h = authHeader(user.id, user.email);
    const url = `${ws(workspace.id)}/lists/${list.id}/tasks`;
    expect((await request(app.getHttpServer()).post(url).set(h).send({ title: 't', priority: 'asap' })).status).toBe(400);
    expect((await request(app.getHttpServer()).post(url).set(h).send({ title: 't', dueTime: '25:00' })).status).toBe(400);
    expect((await request(app.getHttpServer()).post(url).set(h).send({ title: 't', timezone: 'Nowhere/Land' })).status).toBe(400);
    const ok = await request(app.getHttpServer()).post(url).set(h).send({ title: 't', priority: 'high', dueTime: '08:15', timezone: 'Europe/London' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ priority: 'high', dueTime: '08:15', timezone: 'Europe/London' });
  });
});

// ───────────────────────── Filters ─────────────────────────
describe('Tasks — filters', () => {
  it('bad sortBy / sortOrder / status / priority / flags / dates on GET /tasks → 400', async () => {
    const { user, workspace } = await seedWorkspace();
    const h = authHeader(user.id, user.email);
    for (const qs of ['sortBy=assigneeId', 'sortBy=title;drop', 'sortOrder=random', 'status=finished', 'priority=asap', 'archived=yes', 'overdue=2', 'mine=maybe', 'dueFrom=2026-13-01', 'dueFrom=2026-02-31', 'dueTo=11/01/2026', 'dueTo=2026-11-01T00:00:00Z', 'listId=abc', 'creatorId=abc', 'assigneeId=abc']) {
      const res = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?${qs}`).set(h);
      expect([qs, res.status]).toEqual([qs, 400]);
    }
    for (const qs of ['sortBy=dueDate&sortOrder=asc', 'sortBy=title', 'sortBy=updatedAt&sortOrder=desc', 'sortBy=priority']) {
      const res = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?${qs}`).set(h);
      expect([qs, res.status]).toEqual([qs, 200]);
    }
  });

  it('dueFrom / dueTo are inclusive calendar-day bounds', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const mk = (title: string, key: string) => createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title, dueDate: dateKeyToDb(key) });
    await mk('before', '2026-10-31');
    const d1 = await mk('d1', '2026-11-01');
    const d2 = await mk('d2', '2026-11-02');
    const d3 = await mk('d3', '2026-11-03');
    await mk('after', '2026-11-04');
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'no due date' });
    const h = authHeader(user.id, user.email);

    const range = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?dueFrom=2026-11-01&dueTo=2026-11-03&sortBy=dueDate&sortOrder=asc`).set(h);
    expect(range.status).toBe(200);
    expect(range.body.data.map((t: any) => t.id)).toEqual([d1.id, d2.id, d3.id]);

    const fromOnly = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?dueFrom=2026-11-03`).set(h);
    expect(fromOnly.body.data.map((t: any) => t.title).sort()).toEqual(['after', 'd3']);

    const toOnly = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?dueTo=2026-11-01`).set(h);
    expect(toOnly.body.data.map((t: any) => t.title).sort()).toEqual(['before', 'd1']);

    const single = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?dueFrom=2026-11-02&dueTo=2026-11-02`).set(h);
    expect(single.body.data.map((t: any) => t.id)).toEqual([d2.id]);
  });

  it('overdue=1 uses the workspace timezone (settings.timezone), excludes done tasks and today', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    // Pick a zone whose calendar day differs from UTC's right now so a UTC-based
    // implementation would give the wrong answer. UTC+14 and UTC-12 are 26h
    // apart, so at any instant at least one of them is on a different day than UTC.
    const utcToday = todayKey('UTC');
    const tz = todayKey('Pacific/Kiritimati') !== utcToday ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
    const tzToday = todayKey(tz);
    expect(tzToday).not.toBe(utcToday);
    await prisma().workspace.update({ where: { id: workspace.id }, data: { settings: { timezone: tz } } });

    const mk = (title: string, key: string, status = 'todo') => createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title, status, dueDate: dateKeyToDb(key) });
    await mk('yesterday-tz', shiftKey(tzToday, -1));
    await mk('today-tz', tzToday);
    await mk('tomorrow-tz', shiftKey(tzToday, 1));
    await mk('yesterday-tz-done', shiftKey(tzToday, -1), 'done');
    await mk('utc-today', utcToday);
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'no due' });

    const res = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?overdue=1`).set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    const titles = res.body.data.map((t: any) => t.title).sort();
    // The UTC-today task is overdue only if the workspace's day is already past it.
    const expected = ['yesterday-tz', ...(tzToday > utcToday ? ['utc-today'] : [])].sort();
    expect(titles).toEqual(expected);

    // Combines with status: overdue + status=todo still works; overdue + status=done is empty.
    const done = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?overdue=1&status=done`).set(authHeader(user.id, user.email));
    expect(done.body.data).toEqual([]);
  });

  it('mine=1, creatorId, assigneeId, q and listId filters', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const list2 = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'second' });
    const h = authHeader(admin.id, admin.email);

    const mineA = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: empMember.id, assigneeId: adminMember.id, title: 'Invoice the client' });
    const mineB = await createTask({ workspaceId: workspace.id, listId: list2.id, creatorId: adminMember.id, assigneeId: adminMember.id, title: 'Plain', description: 'send INVOICE by friday' });
    const theirs = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id, assigneeId: empMember.id, title: 'Theirs' });
    const nobody = await createTask({ workspaceId: workspace.id, listId: list2.id, creatorId: empMember.id, assigneeId: null, title: 'Unassigned' });

    const ids = (r: any) => r.body.data.map((t: any) => t.id).sort();
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?mine=1`).set(h))).toEqual([mineA.id, mineB.id].sort());
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?creatorId=${empMember.id}`).set(h))).toEqual([mineA.id, nobody.id].sort());
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?assigneeId=${empMember.id}`).set(h))).toEqual([theirs.id]);
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?q=invoice`).set(h))).toEqual([mineA.id, mineB.id].sort());
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?listId=${list2.id}`).set(h))).toEqual([mineB.id, nobody.id].sort());
    // Filters AND together.
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?mine=1&listId=${list2.id}`).set(h))).toEqual([mineB.id]);
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?q=invoice&creatorId=${empMember.id}`).set(h))).toEqual([mineA.id]);
    // mine=0 is a no-op (everything).
    expect(ids(await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?mine=0`).set(h))).toHaveLength(4);
  });

  it('employee: GET /tasks stays scoped to accessible lists; ?listId= of a hidden list is empty, not 403/404', async () => {
    const { workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    await addListMember(list.id, empMember.id, adminMember.id);
    const hidden = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'hidden' });
    const visible = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id, title: 'visible secret' });
    await createTask({ workspaceId: workspace.id, listId: hidden.id, creatorId: adminMember.id, title: 'hidden secret' });
    const h = authHeader(emp.id, emp.email);

    const all = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?q=secret`).set(h);
    expect(all.body.data.map((t: any) => t.id)).toEqual([visible.id]);

    const hiddenList = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?listId=${hidden.id}`).set(h);
    expect(hiddenList.status).toBe(200);
    expect(hiddenList.body.data).toEqual([]);
    expect(hiddenList.body.meta.total).toBe(0);

    const visibleList = await request(app.getHttpServer()).get(`${ws(workspace.id)}/tasks?listId=${list.id}`).set(h);
    expect(visibleList.body.data.map((t: any) => t.id)).toEqual([visible.id]);
  });
});

// ───────────────────────── Reminders re-anchor on due change ─────────────────────────
describe('Tasks — PATCH dueDate/dueTime re-anchors relative reminders', () => {
  it('moving the due date shifts a pending relative reminder; fired reminders and unrelated patches are left alone', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    await prisma().workspace.update({ where: { id: workspace.id }, data: { settings: { timezone: 'UTC' } } });
    const task = await prisma().task.create({ data: { workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'r', dueDate: dateKeyToDb('2026-11-10'), dueTime: '09:00' } });
    // 1 day before 2026-11-10 09:00 UTC.
    const pending = await prisma().reminder.create({ data: { taskId: task.id, workspaceMemberId: member.id, type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'days', nextFireTime: new Date('2026-11-09T09:00:00.000Z'), snoozedUntil: new Date('2026-11-09T10:00:00.000Z') } });
    const fired = await prisma().reminder.create({ data: { taskId: task.id, workspaceMemberId: member.id, type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'days', nextFireTime: new Date('2026-11-09T09:00:00.000Z'), isFired: true } });
    const h = authHeader(user.id, user.email);

    // Unrelated patch: nothing moves.
    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ title: 'renamed' })).status).toBe(200);
    expect((await prisma().reminder.findUnique({ where: { id: pending.id } }))!.nextFireTime).toEqual(new Date('2026-11-09T09:00:00.000Z'));

    // Due date +5 days → reminder follows, snooze cleared.
    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ dueDate: '2026-11-15' })).status).toBe(200);
    const moved = (await prisma().reminder.findUnique({ where: { id: pending.id } }))!;
    expect(moved.nextFireTime).toEqual(new Date('2026-11-14T09:00:00.000Z'));
    expect(moved.snoozedUntil).toBeNull();

    // Due time change alone also re-anchors.
    expect((await request(app.getHttpServer()).patch(`${ws(workspace.id)}/tasks/${task.id}`).set(h).send({ dueTime: '17:30' })).status).toBe(200);
    expect((await prisma().reminder.findUnique({ where: { id: pending.id } }))!.nextFireTime).toEqual(new Date('2026-11-14T17:30:00.000Z'));

    // Fired reminder untouched throughout.
    expect((await prisma().reminder.findUnique({ where: { id: fired.id } }))!.nextFireTime).toEqual(new Date('2026-11-09T09:00:00.000Z'));
  });
});

describe('GET /lists/:lid/tasks access', () => {
  it('employee gets 403 for a list they are not in, 200 once added; foreign list 404', async () => {
    const { user: admin, workspace, member: adminMember, list } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id, title: 'hidden' });

    const denied = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/lists/${list.id}/tasks`)
      .set(authHeader(emp.id, emp.email));
    expect(denied.status).toBe(403);

    await addListMember(list.id, empMember.id);
    const ok = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/lists/${list.id}/tasks`)
      .set(authHeader(emp.id, emp.email));
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((t: any) => t.title)).toEqual(['hidden']);

    const other = await seedWorkspace();
    const foreign = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/lists/${other.list.id}/tasks`)
      .set(authHeader(admin.id, admin.email));
    expect(foreign.status).toBe(404);
  });
});
