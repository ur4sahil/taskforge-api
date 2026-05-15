import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember, createTask } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('Task Permissions', () => {
  it('admin can edit any task in the workspace', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: empMember.id });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(admin.id, admin.email))
      .send({ title: 'Admin edit' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Admin edit');
    void adminMember;
  });

  it('manager-of-assignee can edit a task assigned to their report', async () => {
    const { workspace, list, member: adminMember } = await seedWorkspace();
    const { user: mgrUser } = await createUser();
    const mgrMember = await addMember(workspace.id, mgrUser.id, 'manager');
    const { user: reportUser } = await createUser();
    const reportMember = await addMember(workspace.id, reportUser.id, 'employee', mgrMember.id);

    // Task created by another employee (not admin) and assigned to the report.
    const { user: otherUser } = await createUser();
    const otherMember = await addMember(workspace.id, otherUser.id, 'employee');
    const task = await createTask({
      workspaceId: workspace.id, listId: list.id,
      creatorId: otherMember.id, assigneeId: reportMember.id,
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(mgrUser.id, mgrUser.email))
      .send({ title: 'Manager edits report\'s task' });
    expect(res.status).toBe(200);
    void adminMember;
  });

  it('employee cannot edit a task they did not create and are not assigned to', async () => {
    const { workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    await addMember(workspace.id, emp.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(emp.id, emp.email))
      .send({ title: 'nope' });
    expect(res.status).toBe(403);
  });

  it('creator (employee) can edit their own task', async () => {
    const { workspace, list } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: empMember.id });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(emp.id, emp.email))
      .send({ title: 'my own edit' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('my own edit');
  });

  it('admin-created task is shielded from manager-of-assignee edits', async () => {
    const { workspace, list, member: adminMember } = await seedWorkspace();
    const { user: mgrUser } = await createUser();
    const mgrMember = await addMember(workspace.id, mgrUser.id, 'manager');
    const { user: reportUser } = await createUser();
    const reportMember = await addMember(workspace.id, reportUser.id, 'employee', mgrMember.id);

    const task = await createTask({
      workspaceId: workspace.id, listId: list.id,
      creatorId: adminMember.id, assigneeId: reportMember.id,
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}`)
      .set(authHeader(mgrUser.id, mgrUser.email))
      .send({ title: 'manager tries' });
    expect(res.status).toBe(403);
  });
});
