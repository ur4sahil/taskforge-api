import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember, createList } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('Lists', () => {
  it('POST creates a list (inboundEmail generated, inboundEmailEnabled defaults false)', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/lists`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'Sprint 1' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Sprint 1', workspaceId: workspace.id });
    expect(typeof res.body.data.inboundEmail).toBe('string');
    expect(res.body.data.inboundEmail).toMatch(/@inbound\.test\.local$/);
    expect(res.body.data.inboundEmailEnabled).toBe(false);
  });

  it('PATCH inboundEmailEnabled toggles inbound email on', async () => {
    const { user, workspace } = await seedWorkspace();
    const list = await createList({ workspaceId: workspace.id, createdById: (await prisma().workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace.id } })).id });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/lists/${list.id}`)
      .set(authHeader(user.id, user.email))
      .send({ inboundEmailEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data.inboundEmailEnabled).toBe(true);
  });

  it('admin GET / lists every list in the workspace', async () => {
    const { user, workspace } = await seedWorkspace();
    const ownerMember = await prisma().workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    await createList({ workspaceId: workspace.id, createdById: ownerMember.id, name: 'A' });
    await createList({ workspaceId: workspace.id, createdById: ownerMember.id, name: 'B' });
    await createList({ workspaceId: workspace.id, createdById: ownerMember.id, name: 'C' });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/lists`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
  });

  it('employee only sees lists they are explicitly a member of', async () => {
    const { user: admin, workspace } = await seedWorkspace();
    const adminMember = await prisma().workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace.id, userId: admin.id } });
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');

    const inA = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'Visible' });
    const outA = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'Hidden' });
    await prisma().listMember.create({ data: { listId: inA.id, workspaceMemberId: empMember.id, addedById: adminMember.id } });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/lists`)
      .set(authHeader(emp.id, emp.email));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((l: any) => l.id);
    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(outA.id);
  });

  it('PATCH updates the list name', async () => {
    const { user, workspace } = await seedWorkspace();
    const ownerMember = await prisma().workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    const list = await createList({ workspaceId: workspace.id, createdById: ownerMember.id });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/lists/${list.id}`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'After Rename' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('After Rename');
  });

  it('DELETE removes the list (hard delete via Prisma)', async () => {
    const { user, workspace } = await seedWorkspace();
    const ownerMember = await prisma().workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    const list = await createList({ workspaceId: workspace.id, createdById: ownerMember.id });
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/lists/${list.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });
    const after = await prisma().list.findUnique({ where: { id: list.id } });
    expect(after).toBeNull();
  });
});
