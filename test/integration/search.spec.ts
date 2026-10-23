import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createUser, createWorkspace, addMember, createList, createTask, addListMember } from '../fixtures/factories';
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
    expect(res.body.data).toEqual({ tasks: [], comments: [], totals: { tasks: 0, comments: 0 } });
  });

  it('rejects unauthenticated access with 401', async () => {
    const { workspace } = await seedWorkspace();
    await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=x`).expect(401);
  });
});

describe('Search — scoping', () => {
  it('employee only matches tasks (and comments) in lists they belong to; admin sees all; list.id is returned', async () => {
    const { user: admin, workspace, member: adminMember, list } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    await addListMember(list.id, empMember.id, adminMember.id);
    const hidden = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'hidden' });

    const visible = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id, title: 'budget review visible' });
    const secret = await createTask({ workspaceId: workspace.id, listId: hidden.id, creatorId: adminMember.id, title: 'budget review secret' });
    await prisma().comment.create({ data: { taskId: visible.id, authorId: adminMember.id, body: 'quarterly numbers attached' } });
    await prisma().comment.create({ data: { taskId: secret.id, authorId: adminMember.id, body: 'quarterly numbers are confidential' } });

    const asEmp = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=budget`).set(authHeader(emp.id, emp.email));
    expect(asEmp.status).toBe(200);
    expect(asEmp.body.data.tasks.map((t: any) => t.id)).toEqual([visible.id]);
    expect(asEmp.body.data.tasks[0].list).toEqual({ id: list.id, name: list.name });

    const empComments = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=quarterly`).set(authHeader(emp.id, emp.email));
    expect(empComments.body.data.comments.map((c: any) => c.task.id)).toEqual([visible.id]);

    const asAdmin = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=budget`).set(authHeader(admin.id, admin.email));
    expect(asAdmin.body.data.tasks.map((t: any) => t.id).sort()).toEqual([visible.id, secret.id].sort());
    const adminComments = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=quarterly`).set(authHeader(admin.id, admin.email));
    expect(adminComments.body.data.comments).toHaveLength(2);
  });

  it('manager matches lists containing their direct reports but not unrelated lists', async () => {
    const { workspace, member: adminMember } = await seedWorkspace();
    const { user: mgr } = await createUser();
    const mgrMember = await addMember(workspace.id, mgr.id, 'manager');
    const { user: rep } = await createUser();
    const repMember = await addMember(workspace.id, rep.id, 'employee', mgrMember.id);
    const teamList = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'team' });
    await addListMember(teamList.id, repMember.id, adminMember.id);
    const otherList = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'other' });

    const t1 = await createTask({ workspaceId: workspace.id, listId: teamList.id, creatorId: adminMember.id, title: 'rollout plan' });
    await createTask({ workspaceId: workspace.id, listId: otherList.id, creatorId: adminMember.id, title: 'rollout secret' });

    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=rollout`).set(authHeader(mgr.id, mgr.email));
    expect(res.body.data.tasks.map((t: any) => t.id)).toEqual([t1.id]);
  });

  it('excludes archived tasks and comments on them', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    const live = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'gadget live' });
    const archived = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'gadget archived', archivedAt: new Date() });
    await prisma().comment.create({ data: { taskId: live.id, authorId: member.id, body: 'sprocket here' } });
    await prisma().comment.create({ data: { taskId: archived.id, authorId: member.id, body: 'sprocket there' } });

    const tasks = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=gadget`).set(authHeader(user.id, user.email));
    expect(tasks.body.data.tasks.map((t: any) => t.id)).toEqual([live.id]);
    const comments = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=sprocket`).set(authHeader(user.id, user.email));
    expect(comments.body.data.comments.map((c: any) => c.task.id)).toEqual([live.id]);
  });
});

// ───────────────────────── Caps, meta, single-query scope (QA #32) ───────────
describe('Search — caps and scope', () => {
  it('caps tasks at 25 per page and comments at 25, reporting full totals and meta', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    for (let i = 0; i < 30; i++) await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: `capme ${i}` });
    const t = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'host' });
    await prisma().comment.createMany({ data: Array.from({ length: 28 }, (_, i) => ({ taskId: t.id, authorId: member.id, body: `capme comment ${i}` })) });

    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=capme&perPage=100`).set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toHaveLength(25);
    expect(res.body.data.comments).toHaveLength(25);
    expect(res.body.data.totals).toEqual({ tasks: 30, comments: 28 });
    expect(res.body.meta).toEqual({ page: 1, perPage: 25, total: 30, totalPages: 2 });

    const p2 = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=capme&page=2`).set(authHeader(user.id, user.email));
    expect(p2.body.data.tasks).toHaveLength(5);
    expect(p2.body.meta).toMatchObject({ page: 2, total: 30 });
    // No overlap between pages.
    const ids = new Set([...res.body.data.tasks, ...p2.body.data.tasks].map((x: any) => x.id));
    expect(ids.size).toBe(30);
  });

  it('a smaller perPage is honoured', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    for (let i = 0; i < 6; i++) await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: `few ${i}` });
    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=few&perPage=4`).set(authHeader(user.id, user.email));
    expect(res.body.data.tasks).toHaveLength(4);
    expect(res.body.meta).toEqual({ page: 1, perPage: 4, total: 6, totalPages: 2 });
  });

  it('blank / whitespace query returns empty results with zero totals', async () => {
    const { user, workspace, member, list } = await seedWorkspace();
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'anything' });
    for (const q of ['', '%20%20']) {
      const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=${q}`).set(authHeader(user.id, user.email));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ tasks: [], comments: [], totals: { tasks: 0, comments: 0 } });
    }
  });

  it('a manager matches tasks (and comments) in lists their direct reports are on, but not unrelated lists', async () => {
    const { workspace, member: admin } = await seedWorkspace();
    const { user: mgrUser } = await createUser();
    const mgr = await addMember(workspace.id, mgrUser.id, 'manager');
    const { user: repUser } = await createUser();
    const rep = await addMember(workspace.id, repUser.id, 'employee', mgr.id);
    const { user: otherUser } = await createUser();
    const other = await addMember(workspace.id, otherUser.id, 'employee'); // reports to nobody
    const repList = await createList({ workspaceId: workspace.id, createdById: admin.id });
    await addListMember(repList.id, rep.id);
    const otherList = await createList({ workspaceId: workspace.id, createdById: admin.id });
    await addListMember(otherList.id, other.id);
    const mine = await createList({ workspaceId: workspace.id, createdById: admin.id });
    await addListMember(mine.id, mgr.id);

    const a = await createTask({ workspaceId: workspace.id, listId: repList.id, creatorId: admin.id, title: 'scopeword via report' });
    const b = await createTask({ workspaceId: workspace.id, listId: otherList.id, creatorId: admin.id, title: 'scopeword hidden' });
    const c = await createTask({ workspaceId: workspace.id, listId: mine.id, creatorId: admin.id, title: 'scopeword own list' });
    await prisma().comment.create({ data: { taskId: a.id, authorId: rep.id, body: 'scopeword in a visible comment' } });
    await prisma().comment.create({ data: { taskId: b.id, authorId: other.id, body: 'scopeword in a hidden comment' } });

    const res = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=scopeword`).set(authHeader(mgrUser.id, mgrUser.email));
    expect(res.body.data.tasks.map((t: any) => t.id).sort()).toEqual([a.id, c.id].sort());
    expect(res.body.data.comments.map((x: any) => x.task.id)).toEqual([a.id]);
    expect(res.body.data.totals).toEqual({ tasks: 2, comments: 1 });

    // The same search as the unrelated employee sees only their list.
    const emp = await request(srv()).get(`/api/v1/workspaces/${workspace.id}/search?q=scopeword`).set(authHeader(otherUser.id, otherUser.email));
    expect(emp.body.data.tasks.map((t: any) => t.id)).toEqual([b.id]);
    expect(emp.body.data.comments.map((x: any) => x.task.id)).toEqual([b.id]);
  });

  it('a list membership in another workspace never widens the scope', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const { user: empUser } = await createUser();
    const empA = await addMember(a.workspace.id, empUser.id, 'employee');
    const empB = await addMember(b.workspace.id, empUser.id, 'employee');
    await addListMember(b.list.id, empB.id);
    await createTask({ workspaceId: b.workspace.id, listId: b.list.id, creatorId: b.member.id, title: 'crossws item' });
    // empA is on no list in workspace A → nothing, even though the term exists in B.
    const res = await request(srv()).get(`/api/v1/workspaces/${a.workspace.id}/search?q=crossws`).set(authHeader(empUser.id, empUser.email));
    expect(res.body.data.tasks).toEqual([]);
    expect(res.body.data.totals.tasks).toBe(0);
    expect(empA.id).toBeTruthy();
  });

  it('the trigram indexes from custom_indexes.sql are present on the test DB (global-setup re-applies them after db push)', async () => {
    const rows = await prisma().$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_tasks_title_trgm','idx_tasks_description_trgm','idx_comments_body_trgm') ORDER BY indexname`;
    expect(rows.map(r => r.indexname)).toEqual(['idx_comments_body_trgm', 'idx_tasks_description_trgm', 'idx_tasks_title_trgm']);
  });
});
