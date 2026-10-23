// Cross-workspace IDOR regression suite.
//
// Two fully seeded workspaces, A and B. Every assertion below is made by a member
// of A sending a request to /workspaces/<A>/... but using an id that belongs to
// B. The correct answer is always 404 (never confirm that B's row exists) and
// B's row must be byte-for-byte unchanged afterwards.
//
// Each route also has (1) a positive case — the legitimate caller in A still
// succeeds, so the fix is not over-restrictive — and, where the fix introduced
// an intra-workspace permission rule, (2) an intra-workspace case for that rule.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { R2StorageService } from '../../src/common/utils/r2-storage';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { createUser, createWorkspace, addMember, createList, createTask } from '../fixtures/factories';

class StubStorage {
  async upload() {}
  async getDownloadUrl(key: string) { return `https://files.test/${key}`; }
  async delete() {}
}

let app: INestApplication;
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(R2StorageService).useValue(new StubStorage())
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
});
afterAll(async () => { await app.close(); await disconnect(); });

const srv = () => app.getHttpServer();
const db = () => prisma();

/** One complete workspace: admin + employee, and one of every row type the
 *  routes under test can address. Everything is owned/created by the admin
 *  unless noted, so the employee is a "stranger" to it inside the workspace. */
async function seedFullWorkspace(label: string) {
  const { user: adminUser } = await createUser({ name: `${label} admin` });
  const { user: empUser } = await createUser({ name: `${label} employee` });
  const { workspace, member: admin } = await createWorkspace({ ownerUserId: adminUser.id, name: `WS ${label} ${Date.now()}` });
  const emp = await addMember(workspace.id, empUser.id, 'employee');

  const list = await createList({ workspaceId: workspace.id, createdById: admin.id, name: `${label} list` });
  await db().listMember.create({ data: { listId: list.id, workspaceMemberId: admin.id, addedById: admin.id } });

  const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: admin.id, assigneeId: admin.id, title: `${label} task` });
  const lockedTask = await db().task.create({
    data: { workspaceId: workspace.id, listId: list.id, creatorId: admin.id, assigneeId: admin.id, title: `${label} locked`, isLocked: true, lockedById: admin.id, lockedAt: new Date() },
  });
  const trashedTask = await db().task.create({
    data: { workspaceId: workspace.id, listId: list.id, creatorId: admin.id, assigneeId: admin.id, title: `${label} trashed`, deletedAt: new Date() },
  });

  const check1 = await db().checklistItem.create({ data: { taskId: task.id, text: `${label} step 1`, sortOrder: 0, isChecked: false } });
  const check2 = await db().checklistItem.create({ data: { taskId: task.id, text: `${label} step 2`, sortOrder: 1, isChecked: false } });

  const fireAt = new Date(Date.now() + 3600_000);
  const reminder = await db().reminder.create({
    data: { taskId: task.id, workspaceMemberId: admin.id, type: 'exact', exactTime: fireAt, nextFireTime: fireAt },
  });

  const view = await db().savedView.create({
    data: { workspaceId: workspace.id, createdById: admin.id, name: `${label} view`, type: 'list', visibility: 'personal' },
  });
  const sharedView = await db().savedView.create({
    data: { workspaceId: workspace.id, createdById: admin.id, name: `${label} shared view`, type: 'list', visibility: 'shared' },
  });

  const notification = await db().notification.create({
    data: { workspaceId: workspace.id, recipientId: admin.id, type: 'mention', title: `${label} notif`, body: 'B', isRead: false },
  });

  const comment = await db().comment.create({ data: { taskId: task.id, authorId: admin.id, body: `${label} comment` } });

  const template = await db().template.create({
    data: { workspaceId: workspace.id, type: 'task', name: `${label} personal tmpl`, createdById: admin.id, visibility: 'personal', data: { title: 'x' }, versionHistory: [] },
  });
  const wsTemplate = await db().template.create({
    data: { workspaceId: workspace.id, type: 'task', name: `${label} ws tmpl`, createdById: admin.id, visibility: 'workspace', data: { title: 'x' }, versionHistory: [] },
  });

  const attachment = await db().attachment.create({
    data: { workspaceId: workspace.id, taskId: task.id, uploadedById: admin.id, fileName: `${label}.txt`, fileSize: 3, mimeType: 'text/plain', storageKey: `${workspace.id}/${task.id}/${label}.txt` },
  });
  // Chat attachment: taskId null, hangs off a message.
  const conversation = await db().conversation.create({ data: { workspaceId: workspace.id, name: `${label} chat` } });
  await db().conversationMember.create({ data: { conversationId: conversation.id, workspaceMemberId: admin.id } });
  const message = await db().message.create({ data: { conversationId: conversation.id, senderId: admin.id, body: 'hi' } });
  const chatAttachment = await db().attachment.create({
    data: { workspaceId: workspace.id, taskId: null, messageId: message.id, uploadedById: admin.id, fileName: `${label}-chat.txt`, fileSize: 3, mimeType: 'text/plain', storageKey: `${workspace.id}/chat/${label}.txt` },
  });

  return {
    workspace, admin, emp, adminUser, empUser,
    hAdmin: authHeader(adminUser.id, adminUser.email),
    hEmp: authHeader(empUser.id, empUser.email),
    list, task, lockedTask, trashedTask, check1, check2, reminder, view, sharedView,
    notification, comment, template, wsTemplate, attachment, chatAttachment,
  };
}

type WS = Awaited<ReturnType<typeof seedFullWorkspace>>;
let A: WS;
let B: WS;
/** URL inside workspace A. All cross-workspace probes go through here with B's ids. */
const inA = (path: string) => `/api/v1/workspaces/${A.workspace.id}${path}`;

beforeEach(async () => {
  await truncateAll();
  A = await seedFullWorkspace('A');
  B = await seedFullWorkspace('B');
});

/** Re-read a row and assert it is identical to the snapshot taken before the probe. */
async function expectUnchanged<T>(read: () => Promise<T>, before: T) {
  expect(await read()).toEqual(before);
}

// ───────────────────────────── Lists ─────────────────────────────
describe('Lists', () => {
  it('DELETE /lists/:lid — A admin cannot delete B list (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/lists/${B.list.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect(await db().list.findUnique({ where: { id: B.list.id } })).not.toBeNull();
  });
  it('DELETE /lists/:lid — employee who did not create the list gets 403; creator employee can delete their own', async () => {
    const denied = await request(srv()).delete(inA(`/lists/${A.list.id}`)).set(A.hEmp);
    expect(denied.status).toBe(403);
    expect(await db().list.findUnique({ where: { id: A.list.id } })).not.toBeNull();

    const own = await createList({ workspaceId: A.workspace.id, createdById: A.emp.id });
    const ok = await request(srv()).delete(inA(`/lists/${own.id}`)).set(A.hEmp);
    expect(ok.status).toBe(200);
    expect(await db().list.findUnique({ where: { id: own.id } })).toBeNull();
  });
  it('DELETE /lists/:lid — admin deletes own-workspace list (positive)', async () => {
    const res = await request(srv()).delete(inA(`/lists/${A.list.id}`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(await db().list.findUnique({ where: { id: A.list.id } })).toBeNull();
  });

  it('PATCH /lists/:lid — A admin cannot rename B list (404, unchanged)', async () => {
    const before = await db().list.findUnique({ where: { id: B.list.id } });
    const res = await request(srv()).patch(inA(`/lists/${B.list.id}`)).set(A.hAdmin).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().list.findUnique({ where: { id: B.list.id } }), before);
  });
  it('PATCH /lists/:lid — admin renames own list (positive)', async () => {
    const res = await request(srv()).patch(inA(`/lists/${A.list.id}`)).set(A.hAdmin).send({ name: 'renamed' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('renamed');
  });

  it('GET /lists/:lid — A admin cannot read B list (404)', async () => {
    const res = await request(srv()).get(inA(`/lists/${B.list.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
  });
  it('GET /lists/:lid — admin reads own list (positive)', async () => {
    const res = await request(srv()).get(inA(`/lists/${A.list.id}`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(A.list.id);
  });

  it('POST /lists/:lid/members — A admin cannot add to B list (404, no row)', async () => {
    const res = await request(srv()).post(inA(`/lists/${B.list.id}/members`)).set(A.hAdmin).send({ workspaceMemberId: A.emp.id });
    expect(res.status).toBe(404);
    expect(await db().listMember.count({ where: { listId: B.list.id, workspaceMemberId: A.emp.id } })).toBe(0);
  });
  it('POST /lists/:lid/members — cannot add a B member to an A list (404, no row)', async () => {
    const res = await request(srv()).post(inA(`/lists/${A.list.id}/members`)).set(A.hAdmin).send({ workspaceMemberId: B.emp.id });
    expect(res.status).toBe(404);
    expect(await db().listMember.count({ where: { listId: A.list.id, workspaceMemberId: B.emp.id } })).toBe(0);
  });
  it('POST /lists/:lid/members — admin adds own-workspace member (positive)', async () => {
    const res = await request(srv()).post(inA(`/lists/${A.list.id}/members`)).set(A.hAdmin).send({ workspaceMemberId: A.emp.id });
    expect(res.status).toBe(201);
    expect(await db().listMember.count({ where: { listId: A.list.id, workspaceMemberId: A.emp.id } })).toBe(1);
  });

  it('DELETE /lists/:lid/members/:mid — A admin cannot remove B list member (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/lists/${B.list.id}/members/${B.admin.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect(await db().listMember.count({ where: { listId: B.list.id, workspaceMemberId: B.admin.id } })).toBe(1);
  });
  it('DELETE /lists/:lid/members/:mid — admin removes own list member (positive)', async () => {
    await db().listMember.create({ data: { listId: A.list.id, workspaceMemberId: A.emp.id, addedById: A.admin.id } });
    const res = await request(srv()).delete(inA(`/lists/${A.list.id}/members/${A.emp.id}`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(await db().listMember.count({ where: { listId: A.list.id, workspaceMemberId: A.emp.id } })).toBe(0);
  });
});

// ───────────────────────────── Tasks ─────────────────────────────
describe('Tasks', () => {
  it('POST /tasks/:tid/lock — A admin cannot lock B task (404, unchanged)', async () => {
    const before = await db().task.findUnique({ where: { id: B.task.id } });
    const res = await request(srv()).post(inA(`/tasks/${B.task.id}/lock`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().task.findUnique({ where: { id: B.task.id } }), before);
  });
  it('POST /tasks/:tid/lock — admin locks own task (positive)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${A.task.id}/lock`)).set(A.hAdmin);
    expect(res.status).toBe(201);
    expect((await db().task.findUnique({ where: { id: A.task.id } }))!.isLocked).toBe(true);
  });

  it('DELETE /tasks/:tid/lock — A admin cannot unlock B task (404, still locked)', async () => {
    const res = await request(srv()).delete(inA(`/tasks/${B.lockedTask.id}/lock`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect((await db().task.findUnique({ where: { id: B.lockedTask.id } }))!.isLocked).toBe(true);
  });
  it('DELETE /tasks/:tid/lock — admin unlocks own task (positive)', async () => {
    const res = await request(srv()).delete(inA(`/tasks/${A.lockedTask.id}/lock`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect((await db().task.findUnique({ where: { id: A.lockedTask.id } }))!.isLocked).toBe(false);
  });

  it('POST /tasks/:tid/restore — A admin cannot restore B trashed task (404, still trashed)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${B.trashedTask.id}/restore`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect((await db().task.findUnique({ where: { id: B.trashedTask.id } }))!.deletedAt).not.toBeNull();
  });
  it('POST /tasks/:tid/restore — employee without delete rights gets 403 (still trashed)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${A.trashedTask.id}/restore`)).set(A.hEmp);
    expect(res.status).toBe(403);
    expect((await db().task.findUnique({ where: { id: A.trashedTask.id } }))!.deletedAt).not.toBeNull();
  });
  it('POST /tasks/:tid/restore — admin restores (positive); creator employee restores own task (positive)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${A.trashedTask.id}/restore`)).set(A.hAdmin);
    expect(res.status).toBe(201);
    expect((await db().task.findUnique({ where: { id: A.trashedTask.id } }))!.deletedAt).toBeNull();

    const own = await db().task.create({ data: { workspaceId: A.workspace.id, listId: A.list.id, creatorId: A.emp.id, assigneeId: A.emp.id, title: 'emp own', deletedAt: new Date() } });
    const res2 = await request(srv()).post(inA(`/tasks/${own.id}/restore`)).set(A.hEmp);
    expect(res2.status).toBe(201);
    expect((await db().task.findUnique({ where: { id: own.id } }))!.deletedAt).toBeNull();
  });

  it('POST /tasks/:tid/checklist — A admin cannot add to B task (404, count unchanged)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${B.task.id}/checklist`)).set(A.hAdmin).send({ text: 'injected' });
    expect(res.status).toBe(404);
    expect(await db().checklistItem.count({ where: { taskId: B.task.id } })).toBe(2);
  });
  it('POST /tasks/:tid/checklist — employee who is neither creator nor assignee gets 403; assignee employee (toggle-only rights) also 403', async () => {
    const res = await request(srv()).post(inA(`/tasks/${A.task.id}/checklist`)).set(A.hEmp).send({ text: 'nope' });
    expect(res.status).toBe(403);
    // Make the employee the assignee: they may toggle but still not add.
    await db().task.update({ where: { id: A.task.id }, data: { assigneeId: A.emp.id } });
    const res2 = await request(srv()).post(inA(`/tasks/${A.task.id}/checklist`)).set(A.hEmp).send({ text: 'nope' });
    expect(res2.status).toBe(403);
    expect(await db().checklistItem.count({ where: { taskId: A.task.id } })).toBe(2);
  });
  it('POST /tasks/:tid/checklist — admin adds to own task (positive)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${A.task.id}/checklist`)).set(A.hAdmin).send({ text: 'step 3' });
    expect(res.status).toBe(201);
    expect(await db().checklistItem.count({ where: { taskId: A.task.id } })).toBe(3);
  });

  it('PATCH /tasks/:tid/checklist/reorder — A admin cannot reorder B task (404, order unchanged)', async () => {
    const res = await request(srv()).patch(inA(`/tasks/${B.task.id}/checklist/reorder`)).set(A.hAdmin).send({ itemIds: [B.check2.id, B.check1.id] });
    expect(res.status).toBe(404);
    expect((await db().checklistItem.findUnique({ where: { id: B.check1.id } }))!.sortOrder).toBe(0);
    expect((await db().checklistItem.findUnique({ where: { id: B.check2.id } }))!.sortOrder).toBe(1);
  });
  it('PATCH /tasks/:tid/checklist/reorder — item ids from another task are rejected (400, nothing moved)', async () => {
    const res = await request(srv()).patch(inA(`/tasks/${A.task.id}/checklist/reorder`)).set(A.hAdmin).send({ itemIds: [B.check1.id, A.check1.id] });
    expect(res.status).toBe(400);
    expect((await db().checklistItem.findUnique({ where: { id: B.check1.id } }))!.sortOrder).toBe(0);
    expect((await db().checklistItem.findUnique({ where: { id: A.check1.id } }))!.sortOrder).toBe(0);
  });
  it('PATCH /tasks/:tid/checklist/reorder — admin reorders own task (positive)', async () => {
    const res = await request(srv()).patch(inA(`/tasks/${A.task.id}/checklist/reorder`)).set(A.hAdmin).send({ itemIds: [A.check2.id, A.check1.id] });
    expect(res.status).toBe(200);
    expect((await db().checklistItem.findUnique({ where: { id: A.check2.id } }))!.sortOrder).toBe(0);
    expect((await db().checklistItem.findUnique({ where: { id: A.check1.id } }))!.sortOrder).toBe(1);
  });

  it('PATCH /tasks/:tid/checklist/:cid — A admin cannot toggle B item via B task (404, unchanged)', async () => {
    const res = await request(srv()).patch(inA(`/tasks/${B.task.id}/checklist/${B.check1.id}`)).set(A.hAdmin).send({ isChecked: true });
    expect(res.status).toBe(404);
    expect((await db().checklistItem.findUnique({ where: { id: B.check1.id } }))!.isChecked).toBe(false);
  });
  it('PATCH /tasks/:tid/checklist/:cid — B item id under an A task is 404 (item must belong to the task)', async () => {
    const res = await request(srv()).patch(inA(`/tasks/${A.task.id}/checklist/${B.check1.id}`)).set(A.hAdmin).send({ isChecked: true });
    expect(res.status).toBe(404);
    expect((await db().checklistItem.findUnique({ where: { id: B.check1.id } }))!.isChecked).toBe(false);
  });
  it('PATCH /tasks/:tid/checklist/:cid — assignee employee may toggle but not rename; stranger employee 403', async () => {
    const stranger = await request(srv()).patch(inA(`/tasks/${A.task.id}/checklist/${A.check1.id}`)).set(A.hEmp).send({ isChecked: true });
    expect(stranger.status).toBe(403);
    await db().task.update({ where: { id: A.task.id }, data: { assigneeId: A.emp.id } });
    const toggle = await request(srv()).patch(inA(`/tasks/${A.task.id}/checklist/${A.check1.id}`)).set(A.hEmp).send({ isChecked: true });
    expect(toggle.status).toBe(200);
    expect((await db().checklistItem.findUnique({ where: { id: A.check1.id } }))!.isChecked).toBe(true);
    const rename = await request(srv()).patch(inA(`/tasks/${A.task.id}/checklist/${A.check1.id}`)).set(A.hEmp).send({ text: 'renamed' });
    expect(rename.status).toBe(403);
    expect((await db().checklistItem.findUnique({ where: { id: A.check1.id } }))!.text).toBe('A step 1');
  });
  it('PATCH /tasks/:tid/checklist/:cid — admin renames own item (positive)', async () => {
    const res = await request(srv()).patch(inA(`/tasks/${A.task.id}/checklist/${A.check1.id}`)).set(A.hAdmin).send({ text: 'renamed', isChecked: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ text: 'renamed', isChecked: true });
  });

  it('DELETE /tasks/:tid/checklist/:cid — A admin cannot delete B item (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/tasks/${B.task.id}/checklist/${B.check1.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    const viaOwnTask = await request(srv()).delete(inA(`/tasks/${A.task.id}/checklist/${B.check1.id}`)).set(A.hAdmin);
    expect(viaOwnTask.status).toBe(404);
    expect(await db().checklistItem.findUnique({ where: { id: B.check1.id } })).not.toBeNull();
  });
  it('DELETE /tasks/:tid/checklist/:cid — admin deletes own item (positive)', async () => {
    const res = await request(srv()).delete(inA(`/tasks/${A.task.id}/checklist/${A.check1.id}`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(await db().checklistItem.findUnique({ where: { id: A.check1.id } })).toBeNull();
  });

  it('POST /lists/:lid/tasks — A admin cannot create a task in B list (404, nothing created)', async () => {
    const res = await request(srv()).post(inA(`/lists/${B.list.id}/tasks`)).set(A.hAdmin).send({ title: 'injected' });
    expect(res.status).toBe(404);
    expect(await db().task.count({ where: { listId: B.list.id } })).toBe(3);
    expect(await db().task.count({ where: { title: 'injected' } })).toBe(0);
  });
  it('POST /lists/:lid/tasks — employee not on the list gets 403; once added they can create', async () => {
    const denied = await request(srv()).post(inA(`/lists/${A.list.id}/tasks`)).set(A.hEmp).send({ title: 'emp task' });
    expect(denied.status).toBe(403);
    expect(await db().task.count({ where: { title: 'emp task' } })).toBe(0);
    await db().listMember.create({ data: { listId: A.list.id, workspaceMemberId: A.emp.id, addedById: A.admin.id } });
    const ok = await request(srv()).post(inA(`/lists/${A.list.id}/tasks`)).set(A.hEmp).send({ title: 'emp task' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.listId).toBe(A.list.id);
  });
  it('POST /lists/:lid/tasks — admin creates in own list (positive)', async () => {
    const res = await request(srv()).post(inA(`/lists/${A.list.id}/tasks`)).set(A.hAdmin).send({ title: 'admin task' });
    expect(res.status).toBe(201);
    expect(res.body.data.workspaceId).toBe(A.workspace.id);
  });
});

// ───────────────────────────── Trash ─────────────────────────────
describe('Trash', () => {
  it('DELETE /trash/:tid — A admin cannot purge B trashed task (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/trash/${B.trashedTask.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect(await db().task.findUnique({ where: { id: B.trashedTask.id } })).not.toBeNull();
  });
  it('DELETE /trash/:tid — a task that is NOT in the trash cannot be purged (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/trash/${A.task.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect(await db().task.findUnique({ where: { id: A.task.id } })).not.toBeNull();
  });
  it('DELETE /trash/:tid — admin purges own trashed task (positive)', async () => {
    const res = await request(srv()).delete(inA(`/trash/${A.trashedTask.id}`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(await db().task.findUnique({ where: { id: A.trashedTask.id } })).toBeNull();
  });
});

// ───────────────────────────── Reminders ─────────────────────────────
describe('Reminders', () => {
  it('GET /tasks/:tid/reminders — A admin cannot list B task reminders (404)', async () => {
    const res = await request(srv()).get(inA(`/tasks/${B.task.id}/reminders`)).set(A.hAdmin);
    expect(res.status).toBe(404);
  });
  it('GET /tasks/:tid/reminders — non-admin sees only their own reminders; admin sees all (positive)', async () => {
    const mine = await db().reminder.create({ data: { taskId: A.task.id, workspaceMemberId: A.emp.id, type: 'exact', exactTime: new Date(), nextFireTime: new Date() } });
    const emp = await request(srv()).get(inA(`/tasks/${A.task.id}/reminders`)).set(A.hEmp);
    expect(emp.status).toBe(200);
    expect(emp.body.data.map((r: any) => r.id)).toEqual([mine.id]);
    const admin = await request(srv()).get(inA(`/tasks/${A.task.id}/reminders`)).set(A.hAdmin);
    expect(admin.status).toBe(200);
    expect(admin.body.data).toHaveLength(2);
  });

  it('POST /tasks/:tid/reminders — A admin cannot create a reminder on B task (404, nothing created)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${B.task.id}/reminders`)).set(A.hAdmin).send({ type: 'exact', exactTime: new Date().toISOString() });
    expect(res.status).toBe(404);
    expect(await db().reminder.count({ where: { taskId: B.task.id } })).toBe(1);
  });
  it('POST /tasks/:tid/reminders — admin creates on own task (positive)', async () => {
    const res = await request(srv()).post(inA(`/tasks/${A.task.id}/reminders`)).set(A.hAdmin).send({ type: 'exact', exactTime: new Date().toISOString() });
    expect(res.status).toBe(201);
  });

  it('PATCH /reminders/:rid — A admin cannot update B reminder (404, unchanged)', async () => {
    const before = await db().reminder.findUnique({ where: { id: B.reminder.id } });
    const res = await request(srv()).patch(inA(`/reminders/${B.reminder.id}`)).set(A.hAdmin).send({ exactTime: new Date(Date.now() + 86400_000).toISOString() });
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().reminder.findUnique({ where: { id: B.reminder.id } }), before);
  });
  it('PATCH /reminders/:rid — employee cannot touch another member\'s reminder (404, unchanged); owner and admin can', async () => {
    const before = await db().reminder.findUnique({ where: { id: A.reminder.id } });
    const denied = await request(srv()).patch(inA(`/reminders/${A.reminder.id}`)).set(A.hEmp).send({ exactTime: new Date(Date.now() + 86400_000).toISOString() });
    expect(denied.status).toBe(404);
    await expectUnchanged(() => db().reminder.findUnique({ where: { id: A.reminder.id } }), before);

    const later = new Date(Date.now() + 86400_000);
    const owner = await request(srv()).patch(inA(`/reminders/${A.reminder.id}`)).set(A.hAdmin).send({ exactTime: later.toISOString() });
    expect(owner.status).toBe(200);
    expect(new Date(owner.body.data.exactTime).getTime()).toBe(later.getTime());

    const empsOwn = await db().reminder.create({ data: { taskId: A.task.id, workspaceMemberId: A.emp.id, type: 'exact', exactTime: new Date(), nextFireTime: new Date() } });
    const adminOnEmp = await request(srv()).patch(inA(`/reminders/${empsOwn.id}`)).set(A.hAdmin).send({ exactTime: later.toISOString() });
    expect(adminOnEmp.status).toBe(200);
  });

  it('DELETE /reminders/:rid — A admin cannot delete B reminder (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/reminders/${B.reminder.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect(await db().reminder.findUnique({ where: { id: B.reminder.id } })).not.toBeNull();
  });
  it('DELETE /reminders/:rid — employee cannot delete admin\'s reminder (404); owner can (positive)', async () => {
    const denied = await request(srv()).delete(inA(`/reminders/${A.reminder.id}`)).set(A.hEmp);
    expect(denied.status).toBe(404);
    expect(await db().reminder.findUnique({ where: { id: A.reminder.id } })).not.toBeNull();
    const ok = await request(srv()).delete(inA(`/reminders/${A.reminder.id}`)).set(A.hAdmin);
    expect(ok.status).toBe(200);
    expect(await db().reminder.findUnique({ where: { id: A.reminder.id } })).toBeNull();
  });

  it('POST /reminders/:rid/snooze — A admin cannot snooze B reminder (404, unchanged)', async () => {
    const before = await db().reminder.findUnique({ where: { id: B.reminder.id } });
    const res = await request(srv()).post(inA(`/reminders/${B.reminder.id}/snooze`)).set(A.hAdmin).send({});
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().reminder.findUnique({ where: { id: B.reminder.id } }), before);
  });
  it('POST /reminders/:rid/snooze — owner snoozes own (positive)', async () => {
    const res = await request(srv()).post(inA(`/reminders/${A.reminder.id}/snooze`)).set(A.hAdmin).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.snoozedUntil).not.toBeNull();
  });

  it('POST /reminders/:rid/dismiss — A admin cannot dismiss B reminder (404, unchanged)', async () => {
    const res = await request(srv()).post(inA(`/reminders/${B.reminder.id}/dismiss`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect((await db().reminder.findUnique({ where: { id: B.reminder.id } }))!.isDismissed).toBe(false);
  });
  it('POST /reminders/:rid/dismiss — owner dismisses own (positive)', async () => {
    const res = await request(srv()).post(inA(`/reminders/${A.reminder.id}/dismiss`)).set(A.hAdmin);
    expect(res.status).toBe(201);
    expect((await db().reminder.findUnique({ where: { id: A.reminder.id } }))!.isDismissed).toBe(true);
  });
});

// ───────────────────────────── Views ─────────────────────────────
describe('Views', () => {
  it('PATCH /views/:vid — A admin cannot update B view (404, unchanged)', async () => {
    const before = await db().savedView.findUnique({ where: { id: B.view.id } });
    const res = await request(srv()).patch(inA(`/views/${B.view.id}`)).set(A.hAdmin).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().savedView.findUnique({ where: { id: B.view.id } }), before);
  });
  it('PATCH /views/:vid — employee cannot edit another member\'s personal view (404) but can edit a shared one', async () => {
    const denied = await request(srv()).patch(inA(`/views/${A.view.id}`)).set(A.hEmp).send({ name: 'pwned' });
    expect(denied.status).toBe(404);
    expect((await db().savedView.findUnique({ where: { id: A.view.id } }))!.name).toBe('A view');
    const shared = await request(srv()).patch(inA(`/views/${A.sharedView.id}`)).set(A.hEmp).send({ name: 'team renamed' });
    expect(shared.status).toBe(200);
    expect(shared.body.data.name).toBe('team renamed');
  });
  it('PATCH /views/:vid — owner updates own personal view (positive)', async () => {
    const res = await request(srv()).patch(inA(`/views/${A.view.id}`)).set(A.hAdmin).send({ name: 'mine renamed' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('mine renamed');
  });

  it('DELETE /views/:vid — A admin cannot delete B view (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/views/${B.view.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect(await db().savedView.findUnique({ where: { id: B.view.id } })).not.toBeNull();
  });
  it('DELETE /views/:vid — employee cannot delete admin\'s personal view (404); owner can (positive)', async () => {
    const denied = await request(srv()).delete(inA(`/views/${A.view.id}`)).set(A.hEmp);
    expect(denied.status).toBe(404);
    expect(await db().savedView.findUnique({ where: { id: A.view.id } })).not.toBeNull();
    const ok = await request(srv()).delete(inA(`/views/${A.view.id}`)).set(A.hAdmin);
    expect(ok.status).toBe(200);
    expect(await db().savedView.findUnique({ where: { id: A.view.id } })).toBeNull();
  });
});

// ───────────────────────────── Notifications ─────────────────────────────
describe('Notifications', () => {
  it('PATCH /notifications/:nid/read — A admin cannot mark B notification read (404, unchanged)', async () => {
    const res = await request(srv()).patch(inA(`/notifications/${B.notification.id}/read`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    const row = await db().notification.findUnique({ where: { id: B.notification.id } });
    expect(row!.isRead).toBe(false);
    expect(row!.readAt).toBeNull();
  });
  it('PATCH /notifications/:nid/read — employee cannot mark another member\'s notification read (404, unchanged)', async () => {
    const res = await request(srv()).patch(inA(`/notifications/${A.notification.id}/read`)).set(A.hEmp);
    expect(res.status).toBe(404);
    expect((await db().notification.findUnique({ where: { id: A.notification.id } }))!.isRead).toBe(false);
  });
  it('PATCH /notifications/:nid/read — recipient marks own read (positive)', async () => {
    const res = await request(srv()).patch(inA(`/notifications/${A.notification.id}/read`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
    expect(res.body.data.readAt).not.toBeNull();
  });
});

// ───────────────────────────── Workspace members ─────────────────────────────
describe('Workspace members', () => {
  it('POST /members/:mid/deactivate — A admin cannot deactivate B member (404, still active)', async () => {
    const res = await request(srv()).post(inA(`/members/${B.emp.id}/deactivate`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect((await db().workspaceMember.findUnique({ where: { id: B.emp.id } }))!.isActive).toBe(true);
  });
  it('POST /members/:mid/deactivate — admin deactivates own-workspace member (positive)', async () => {
    const res = await request(srv()).post(inA(`/members/${A.emp.id}/deactivate`)).set(A.hAdmin);
    expect(res.status).toBe(201);
    expect((await db().workspaceMember.findUnique({ where: { id: A.emp.id } }))!.isActive).toBe(false);
  });

  it('POST /members/:mid/reactivate — A admin cannot reactivate B member (404, still inactive)', async () => {
    await db().workspaceMember.update({ where: { id: B.emp.id }, data: { isActive: false } });
    const res = await request(srv()).post(inA(`/members/${B.emp.id}/reactivate`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect((await db().workspaceMember.findUnique({ where: { id: B.emp.id } }))!.isActive).toBe(false);
  });
  it('POST /members/:mid/reactivate — admin reactivates own-workspace member (positive)', async () => {
    await db().workspaceMember.update({ where: { id: A.emp.id }, data: { isActive: false } });
    const res = await request(srv()).post(inA(`/members/${A.emp.id}/reactivate`)).set(A.hAdmin);
    expect(res.status).toBe(201);
    expect((await db().workspaceMember.findUnique({ where: { id: A.emp.id } }))!.isActive).toBe(true);
  });

  it('PATCH /members/:mid — A admin cannot update B member (404, unchanged)', async () => {
    const before = await db().workspaceMember.findUnique({ where: { id: B.emp.id } });
    const res = await request(srv()).patch(inA(`/members/${B.emp.id}`)).set(A.hAdmin).send({ role: 'admin' });
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().workspaceMember.findUnique({ where: { id: B.emp.id } }), before);
  });
  it('PATCH /members/:mid — managerId must be an active member of the same workspace and not self (400, unchanged)', async () => {
    const before = await db().workspaceMember.findUnique({ where: { id: A.emp.id } });
    const foreign = await request(srv()).patch(inA(`/members/${A.emp.id}`)).set(A.hAdmin).send({ managerId: B.admin.id });
    expect(foreign.status).toBe(400);
    const self = await request(srv()).patch(inA(`/members/${A.emp.id}`)).set(A.hAdmin).send({ managerId: A.emp.id });
    expect(self.status).toBe(400);
    const { user: u } = await createUser();
    const inactive = await addMember(A.workspace.id, u.id, 'manager');
    await db().workspaceMember.update({ where: { id: inactive.id }, data: { isActive: false } });
    const deactivated = await request(srv()).patch(inA(`/members/${A.emp.id}`)).set(A.hAdmin).send({ managerId: inactive.id });
    expect(deactivated.status).toBe(400);
    await expectUnchanged(() => db().workspaceMember.findUnique({ where: { id: A.emp.id } }), before);
  });
  it('PATCH /members/:mid — valid managerId in the same workspace is accepted; null clears it (positive)', async () => {
    const set = await request(srv()).patch(inA(`/members/${A.emp.id}`)).set(A.hAdmin).send({ managerId: A.admin.id });
    expect(set.status).toBe(200);
    expect(set.body.data.managerId).toBe(A.admin.id);
    const clear = await request(srv()).patch(inA(`/members/${A.emp.id}`)).set(A.hAdmin).send({ managerId: null });
    expect(clear.status).toBe(200);
    expect(clear.body.data.managerId).toBeNull();
  });
});

// ───────────────────────────── Comments ─────────────────────────────
describe('Comments', () => {
  it('GET /tasks/:tid/comments — A admin cannot list B task comments (404)', async () => {
    const res = await request(srv()).get(inA(`/tasks/${B.task.id}/comments`)).set(A.hAdmin);
    expect(res.status).toBe(404);
  });
  it('GET /tasks/:tid/comments — admin lists own task comments (positive)', async () => {
    const res = await request(srv()).get(inA(`/tasks/${A.task.id}/comments`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: any) => c.id)).toEqual([A.comment.id]);
  });

  it('DELETE /tasks/:tid/comments/:cid — A admin cannot delete B comment (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/tasks/${B.task.id}/comments/${B.comment.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    const viaOwnTask = await request(srv()).delete(inA(`/tasks/${A.task.id}/comments/${B.comment.id}`)).set(A.hAdmin);
    expect(viaOwnTask.status).toBe(404);
    expect(await db().comment.findUnique({ where: { id: B.comment.id } })).not.toBeNull();
  });
  it('DELETE /tasks/:tid/comments/:cid — author deletes own comment (positive)', async () => {
    const res = await request(srv()).delete(inA(`/tasks/${A.task.id}/comments/${A.comment.id}`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(await db().comment.findUnique({ where: { id: A.comment.id } })).toBeNull();
  });
});

// ───────────────────────────── Templates ─────────────────────────────
describe('Templates', () => {
  it('GET /templates/:tid — A admin cannot read B template (404), even a workspace-visible one', async () => {
    expect((await request(srv()).get(inA(`/templates/${B.template.id}`)).set(A.hAdmin)).status).toBe(404);
    expect((await request(srv()).get(inA(`/templates/${B.wsTemplate.id}`)).set(A.hAdmin)).status).toBe(404);
  });
  it('GET /templates/:tid — employee cannot read another member\'s personal template (404) but can read a workspace one', async () => {
    expect((await request(srv()).get(inA(`/templates/${A.template.id}`)).set(A.hEmp)).status).toBe(404);
    const ws = await request(srv()).get(inA(`/templates/${A.wsTemplate.id}`)).set(A.hEmp);
    expect(ws.status).toBe(200);
    expect(ws.body.data.id).toBe(A.wsTemplate.id);
  });
  it('GET /templates/:tid — owner reads own personal template; admin reads an employee\'s personal one (positive)', async () => {
    expect((await request(srv()).get(inA(`/templates/${A.template.id}`)).set(A.hAdmin)).status).toBe(200);
    const empTmpl = await db().template.create({ data: { workspaceId: A.workspace.id, type: 'task', name: 'emp pers', createdById: A.emp.id, visibility: 'personal', data: {}, versionHistory: [] } });
    expect((await request(srv()).get(inA(`/templates/${empTmpl.id}`)).set(A.hEmp)).status).toBe(200);
    expect((await request(srv()).get(inA(`/templates/${empTmpl.id}`)).set(A.hAdmin)).status).toBe(200);
  });

  it('PATCH /templates/:tid — A admin cannot update B template (404, unchanged)', async () => {
    const before = await db().template.findUnique({ where: { id: B.template.id } });
    const res = await request(srv()).patch(inA(`/templates/${B.template.id}`)).set(A.hAdmin).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().template.findUnique({ where: { id: B.template.id } }), before);
  });
  it('PATCH /templates/:tid — employee cannot update another member\'s personal template (404, unchanged)', async () => {
    const before = await db().template.findUnique({ where: { id: A.template.id } });
    const res = await request(srv()).patch(inA(`/templates/${A.template.id}`)).set(A.hEmp).send({ name: 'pwned' });
    expect(res.status).toBe(404);
    await expectUnchanged(() => db().template.findUnique({ where: { id: A.template.id } }), before);
  });
  it('PATCH /templates/:tid — owner updates own template (positive, version bumps)', async () => {
    const res = await request(srv()).patch(inA(`/templates/${A.template.id}`)).set(A.hAdmin).send({ name: 'v2' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'v2', version: 2 });
  });

  it('DELETE /templates/:tid — A admin cannot delete B template (404, row intact)', async () => {
    const res = await request(srv()).delete(inA(`/templates/${B.template.id}`)).set(A.hAdmin);
    expect(res.status).toBe(404);
    expect(await db().template.findUnique({ where: { id: B.template.id } })).not.toBeNull();
  });
  it('DELETE /templates/:tid — employee cannot delete another member\'s personal template (404); admin can delete an employee\'s', async () => {
    const denied = await request(srv()).delete(inA(`/templates/${A.template.id}`)).set(A.hEmp);
    expect(denied.status).toBe(404);
    expect(await db().template.findUnique({ where: { id: A.template.id } })).not.toBeNull();
    const empTmpl = await db().template.create({ data: { workspaceId: A.workspace.id, type: 'task', name: 'emp pers', createdById: A.emp.id, visibility: 'personal', data: {}, versionHistory: [] } });
    const ok = await request(srv()).delete(inA(`/templates/${empTmpl.id}`)).set(A.hAdmin);
    expect(ok.status).toBe(200);
    expect(await db().template.findUnique({ where: { id: empTmpl.id } })).toBeNull();
  });
  it('DELETE /templates/:tid — owner deletes own template (positive)', async () => {
    const res = await request(srv()).delete(inA(`/templates/${A.template.id}`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(await db().template.findUnique({ where: { id: A.template.id } })).toBeNull();
  });
});

// ───────────────────────────── Attachments ─────────────────────────────
describe('Attachments', () => {
  it('GET /attachments/:aid/url — A admin cannot fetch B task attachment (404)', async () => {
    const res = await request(srv()).get(inA(`/attachments/${B.attachment.id}/url`)).set(A.hAdmin);
    expect(res.status).toBe(404);
  });
  it('GET /attachments/:aid/url — chat attachments are not served by this route (404), even in own workspace', async () => {
    expect((await request(srv()).get(inA(`/attachments/${A.chatAttachment.id}/url`)).set(A.hAdmin)).status).toBe(404);
    expect((await request(srv()).get(inA(`/attachments/${B.chatAttachment.id}/url`)).set(A.hAdmin)).status).toBe(404);
  });
  it('GET /attachments/:aid/url — own task attachment returns a URL (positive)', async () => {
    const res = await request(srv()).get(inA(`/attachments/${A.attachment.id}/url`)).set(A.hAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(`https://files.test/${A.attachment.storageKey}`);
    expect(res.body.data.fileName).toBe('A.txt');
  });
});
