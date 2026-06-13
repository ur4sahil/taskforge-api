import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createUser, addMember } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

describe('Saved Views', () => {
  it('creates a view with sensible defaults (personal visibility, list type, empty filters)', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/views`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'My Board' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'My Board', type: 'list', visibility: 'personal' });
    expect(res.body.data.filters).toEqual({});
  });

  it('persists supplied type, filters, sort, groupBy, and visibility', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/views`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'Team Board', type: 'board', visibility: 'shared', filters: { status: ['todo'] }, sort: { field: 'dueDate', dir: 'asc' }, groupBy: 'status' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'board', visibility: 'shared', groupBy: 'status',
      filters: { status: ['todo'] }, sort: { field: 'dueDate', dir: 'asc' },
    });
  });

  it('rejects an empty name with 400', async () => {
    const { user, workspace } = await seedWorkspace();
    await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/views`)
      .set(authHeader(user.id, user.email))
      .send({ name: '' })
      .expect(400);
  });

  it('findAll returns my personal views + shared views, but not other members\' personal views', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const { user: other } = await createUser();
    const otherMember = await addMember(workspace.id, other.id, 'employee');

    await prisma().savedView.createMany({
      data: [
        { workspaceId: workspace.id, createdById: member.id, name: 'mine-personal', type: 'list', visibility: 'personal' },
        { workspaceId: workspace.id, createdById: otherMember.id, name: 'theirs-shared', type: 'list', visibility: 'shared' },
        { workspaceId: workspace.id, createdById: otherMember.id, name: 'theirs-personal', type: 'list', visibility: 'personal' },
      ],
    });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/views`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    const names = res.body.data.map((v: any) => v.name).sort();
    expect(names).toEqual(['mine-personal', 'theirs-shared']);
  });

  it('paginates and returns pagination meta', async () => {
    const { user, workspace, member } = await seedWorkspace();
    await prisma().savedView.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({ workspaceId: workspace.id, createdById: member.id, name: `v${i}`, type: 'list' as any, visibility: 'personal' as any })),
    });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/views?page=1&perPage=2`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ total: 5, page: 1, perPage: 2 });
  });

  it('updates only the supplied fields', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const v = await prisma().savedView.create({ data: { workspaceId: workspace.id, createdById: member.id, name: 'before', type: 'list', visibility: 'personal' } });
    const res = await request(srv())
      .patch(`/api/v1/workspaces/${workspace.id}/views/${v.id}`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'after', visibility: 'shared' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'after', visibility: 'shared', type: 'list' });
  });

  it('deletes a view', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const v = await prisma().savedView.create({ data: { workspaceId: workspace.id, createdById: member.id, name: 'gone', type: 'list', visibility: 'personal' } });
    const res = await request(srv())
      .delete(`/api/v1/workspaces/${workspace.id}/views/${v.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(await prisma().savedView.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it('rejects unauthenticated access with 401', async () => {
    const { workspace } = await seedWorkspace();
    await request(srv()).get(`/api/v1/workspaces/${workspace.id}/views`).expect(401);
  });
});
