import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember, createTask } from '../fixtures/factories';

// GET /workspaces/:wid/tasks/:tid/activity — audit rows for the task merged
// with its comments, newest first, paginated (QA #12).

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

// The audit interceptor writes after the response is sent; poll until the
// expected number of rows for this task exists.
async function waitForAudits(taskId: string, n: number, tries = 25, delayMs = 40) {
  for (let i = 0; i < tries; i++) {
    const c = await prisma().auditLog.count({ where: { entityType: 'task', entityId: taskId } });
    if (c >= n) return;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`expected ${n} audit rows for task ${taskId}`);
}

describe('Task activity', () => {
  it('merges audit entries and comments newest-first with actor names and summaries', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    await prisma().user.update({ where: { id: user.id }, data: { name: 'Ada Admin' } });
    const { user: peerUser } = await createUser({ name: 'Pete Peer' });
    const peer = await addMember(workspace.id, peerUser.id, 'employee');

    const created = await request(srv()).post(`/api/v1/workspaces/${workspace.id}/lists/${list.id}/tasks`)
      .set(authHeader(user.id, user.email)).send({ title: 'Ship it' });
    expect(created.status).toBe(201);
    const tid = created.body.data.id;
    await waitForAudits(tid, 1);

    await request(srv()).patch(`/api/v1/workspaces/${workspace.id}/tasks/${tid}`)
      .set(authHeader(user.id, user.email)).send({ status: 'in_progress' }).expect(200);
    await waitForAudits(tid, 2);

    // A comment by someone else, dated after the audit rows.
    await prisma().comment.create({ data: { taskId: tid, authorId: peer.id, body: '  Looks   good to me, ' + 'x'.repeat(200), createdAt: new Date(Date.now() + 1000) } });

    await request(srv()).patch(`/api/v1/workspaces/${workspace.id}/tasks/${tid}`)
      .set(authHeader(user.id, user.email)).send({ title: 'Ship it now', priority: 'high' }).expect(200);
    await waitForAudits(tid, 3);
    // Make the last audit row the newest for sure.
    const last = await prisma().auditLog.findFirst({ where: { entityId: tid, action: 'task.updated', changes: { path: ['title'], equals: 'Ship it now' } } });
    await prisma().auditLog.update({ where: { id: last!.id }, data: { createdAt: new Date(Date.now() + 2000) } });

    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/tasks/${tid}/activity`).set(authHeader(peerUser.id, peerUser.email));
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, perPage: 50, total: 4, totalPages: 1 });
    const items = res.body.data;
    expect(items).toHaveLength(4);
    expect(items.map((i: any) => i.kind)).toEqual(['audit', 'comment', 'audit', 'audit']);
    expect(items.map((i: any) => i.action)).toEqual(['task.updated', 'comment.created', 'task.updated', 'task.created']);
    // Strictly newest-first.
    const ts = items.map((i: any) => new Date(i.at).getTime());
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);

    expect(items[0]).toMatchObject({ actorName: 'Ada Admin', summary: 'Updated title, priority', changes: { title: 'Ship it now', priority: 'high' } });
    expect(items[1]).toMatchObject({ actorName: 'Pete Peer', kind: 'comment' });
    expect(items[1].summary.startsWith('Looks good to me, xxx')).toBe(true);
    expect(items[1].summary.length).toBe(140);
    expect(items[1].summary.endsWith('…')).toBe(true);
    expect(items[1]).not.toHaveProperty('changes');
    expect(items[2]).toMatchObject({ summary: 'Changed status to in progress', changes: { status: 'in_progress' } });
    expect(items[3]).toMatchObject({ summary: 'Created "Ship it"', changes: { title: 'Ship it' } });
  });

  it('paginates across both sources (perPage honoured, default 50)', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const t = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const base = Date.now() - 100_000;
    for (let i = 0; i < 4; i++) {
      await prisma().auditLog.create({ data: { workspaceId: workspace.id, actorId: member.id, action: 'task.updated', entityType: 'task', entityId: t.id, changes: { n: i }, createdAt: new Date(base + i * 2000) } });
      await prisma().comment.create({ data: { taskId: t.id, authorId: member.id, body: `c${i}`, createdAt: new Date(base + i * 2000 + 1000) } });
    }
    const p1 = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/tasks/${t.id}/activity?perPage=3`).set(authHeader(user.id, user.email));
    expect(p1.body.meta).toEqual({ page: 1, perPage: 3, total: 8, totalPages: 3 });
    expect(p1.body.data.map((i: any) => i.summary)).toEqual(['c3', 'Updated n', 'c2']);
    const p3 = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/tasks/${t.id}/activity?perPage=3&page=3`).set(authHeader(user.id, user.email));
    expect(p3.body.data.map((i: any) => i.summary)).toEqual(['c0', 'Updated n']);
    const def = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/tasks/${t.id}/activity`).set(authHeader(user.id, user.email));
    expect(def.body.meta.perPage).toBe(50);
    expect(def.body.data).toHaveLength(8);
  });

  it('is scoped to the workspace: audit rows for the same entity id in another workspace are not shown, and a foreign task 404s', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const t = await createTask({ workspaceId: a.workspace.id, listId: a.list.id, creatorId: a.member.id });
    await prisma().auditLog.create({ data: { workspaceId: a.workspace.id, actorId: a.member.id, action: 'task.archived', entityType: 'task', entityId: t.id, changes: {} } });
    await prisma().auditLog.create({ data: { workspaceId: b.workspace.id, actorId: b.member.id, action: 'task.unarchived', entityType: 'task', entityId: t.id, changes: {} } });
    // Same id, different entity type — must not bleed in either.
    await prisma().auditLog.create({ data: { workspaceId: a.workspace.id, actorId: a.member.id, action: 'member.password-rotated', entityType: 'workspaceMember', entityId: t.id, changes: {} } });

    const res = await request(srv()).get(`/api/v1/workspaces/${a.workspace.id}/tasks/${t.id}/activity`).set(authHeader(a.user.id, a.user.email));
    expect(res.body.data.map((i: any) => i.action)).toEqual(['task.archived']);
    expect(res.body.data[0].summary).toBe('Archived');

    await request(srv()).get(`/api/v1/workspaces/${b.workspace.id}/tasks/${t.id}/activity`).set(authHeader(b.user.id, b.user.email)).expect(404);
  });

  it('an audit row whose actor is gone reads as System', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const t = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    await prisma().auditLog.create({ data: { workspaceId: workspace.id, actorId: null, action: 'task.updated', entityType: 'task', entityId: t.id, changes: { assigneeId: null } } });
    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/tasks/${t.id}/activity`).set(authHeader(user.id, user.email));
    expect(res.body.data[0]).toMatchObject({ actorName: 'System', summary: 'Unassigned' });
  });

  it('an empty history is an empty page, and a non-member is 403', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const t = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });
    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/tasks/${t.id}/activity`).set(authHeader(user.id, user.email));
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
    const { user: stranger } = await createUser();
    await request(srv()).get(`/api/v1/workspaces/${workspace.id}/tasks/${t.id}/activity`).set(authHeader(stranger.id, stranger.email)).expect(403);
  });
});
