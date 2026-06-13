import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createUser, createWorkspace, createList, createTask } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

describe('Search', () => {
  it('matches task titles case-insensitively', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'Fix the Login Bug' });
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'Unrelated work' });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/search?q=login`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toHaveLength(1);
    expect(res.body.data.tasks[0].title).toBe('Fix the Login Bug');
  });

  it('matches task descriptions', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    await prisma().task.create({ data: { workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'Plain title', description: 'contains a needle here', status: 'todo' } });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/search?q=needle`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data.tasks).toHaveLength(1);
  });

  it('matches comment bodies and returns the parent task', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'Has a comment' });
    await prisma().comment.create({ data: { taskId: task.id, authorId: member.id, body: 'please review the deployment pipeline' } });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/search?q=pipeline`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data.comments).toHaveLength(1);
    expect(res.body.data.comments[0].task.id).toBe(task.id);
  });

  it('excludes soft-deleted tasks', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const t = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'deleteme widget' });
    await prisma().task.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/search?q=widget`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data.tasks).toHaveLength(0);
  });

  it('does not leak results from another workspace', async () => {
    const { user, workspace } = await seedWorkspace();
    const { user: other } = await createUser();
    const { workspace: otherWs, member: otherMember } = await createWorkspace({ ownerUserId: other.id });
    const otherList = await createList({ workspaceId: otherWs.id, createdById: otherMember.id });
    await createTask({ workspaceId: otherWs.id, listId: otherList.id, creatorId: otherMember.id, title: 'secret cross-workspace task' });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/search?q=secret`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data.tasks).toHaveLength(0);
  });

  it('returns empty arrays for a blank query', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'anything' });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/search?q=`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data).toEqual({ tasks: [], comments: [] });
  });

  it('rejects unauthenticated access with 401', async () => {
    const { workspace } = await seedWorkspace();
    await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=x`).expect(401);
  });
});
