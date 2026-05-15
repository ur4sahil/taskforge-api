import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember, createList, createTask } from '../fixtures/factories';

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
