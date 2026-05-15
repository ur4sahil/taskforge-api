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

describe('Trash', () => {
  it('GET /trash lists soft-deleted tasks in the workspace', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const t1 = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'gone-1' });
    const t2 = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'gone-2' });
    await prisma().task.update({ where: { id: t1.id }, data: { deletedAt: new Date() } });
    await prisma().task.update({ where: { id: t2.id }, data: { deletedAt: new Date() } });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/trash`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining([t1.id, t2.id]));
  });

  it('POST /tasks/:tid/restore clears deletedAt', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const t = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().task.update({ where: { id: t.id }, data: { deletedAt: new Date() } });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${t.id}/restore`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(201);
    const row = await prisma().task.findUnique({ where: { id: t.id } });
    expect(row!.deletedAt).toBeNull();
  });

  it('admin DELETE permanently removes; employee returns 403', async () => {
    const { user: admin, workspace, list, member } = await seedWorkspace();
    const { user: emp } = await createUser();
    await addMember(workspace.id, emp.id, 'employee');

    const t = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().task.update({ where: { id: t.id }, data: { deletedAt: new Date() } });

    const denied = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/trash/${t.id}`)
      .set(authHeader(emp.id, emp.email));
    expect(denied.status).toBe(403);

    const ok = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/trash/${t.id}`)
      .set(authHeader(admin.id, admin.email));
    expect(ok.status).toBe(200);

    const row = await prisma().task.findUnique({ where: { id: t.id } });
    expect(row).toBeNull();
  });
});
