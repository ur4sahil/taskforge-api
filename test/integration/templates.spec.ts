// Integration tests for the Templates module.
// templates.module.ts was at 31.8% coverage. Templates CRUD + the
// save-as / apply round-trip is what users actually run.
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createTask, createUser, addMember } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('Templates', () => {
  it('POST /templates creates a personal task template', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/templates`)
      .set(authHeader(user.id, user.email))
      .send({ type: 'task', name: 'Daily standup', visibility: 'personal', data: { title: 'Daily standup', priority: 'medium' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'task', name: 'Daily standup', visibility: 'personal' });
    expect(res.body.data.data).toMatchObject({ title: 'Daily standup' });
  });

  it('GET /templates lists personal-only for the caller PLUS workspace-shared (regardless of creator)', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const { user: alice } = await createUser();
    const aliceMember = await addMember(workspace.id, alice.id, 'employee');
    // 3 rows: mine personal, mine workspace, alice's personal, alice's workspace.
    await prisma().template.createMany({
      data: [
        { workspaceId: workspace.id, type: 'task' as any, name: 'mine-pers', createdById: member.id, visibility: 'personal' as any, data: {} as any, versionHistory: [] as any },
        { workspaceId: workspace.id, type: 'task' as any, name: 'mine-ws', createdById: member.id, visibility: 'workspace' as any, data: {} as any, versionHistory: [] as any },
        { workspaceId: workspace.id, type: 'task' as any, name: 'alice-pers', createdById: aliceMember.id, visibility: 'personal' as any, data: {} as any, versionHistory: [] as any },
        { workspaceId: workspace.id, type: 'task' as any, name: 'alice-ws', createdById: aliceMember.id, visibility: 'workspace' as any, data: {} as any, versionHistory: [] as any },
      ],
    });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/templates?perPage=10`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    const names = res.body.data.map((t: any) => t.name).sort();
    // mine-pers + mine-ws + alice-ws (alice-pers excluded — not visible to me)
    expect(names).toEqual(['alice-ws', 'mine-pers', 'mine-ws']);
  });

  it('GET /templates/:tid returns one template', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const tmpl = await prisma().template.create({
      data: { workspaceId: workspace.id, type: 'task' as any, name: 'X', createdById: member.id, visibility: 'workspace' as any, data: { title: 'X' } as any, versionHistory: [] as any },
    });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/templates/${tmpl.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(tmpl.id);
  });

  it('DELETE /templates/:tid removes the row', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const tmpl = await prisma().template.create({
      data: { workspaceId: workspace.id, type: 'task' as any, name: 'gone', createdById: member.id, visibility: 'personal' as any, data: {} as any, versionHistory: [] as any },
    });
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/templates/${tmpl.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(await prisma().template.findUnique({ where: { id: tmpl.id } })).toBeNull();
  });

  it('POST /tasks/:tid/save-as-template captures the task and creates a task template', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'Source', priority: 'high' });
    await prisma().checklistItem.create({ data: { taskId: task.id, text: 'step 1', sortOrder: 0 } });
    await prisma().checklistItem.create({ data: { taskId: task.id, text: 'step 2', sortOrder: 1 } });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/save-as-template`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'Source template', visibility: 'workspace' });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('task');
    const data = res.body.data.data;
    expect(data.title).toBe('Source');
    expect(data.priority).toBe('high');
    expect(data.checklistItems).toEqual([
      { text: 'step 1', sortOrder: 0 },
      { text: 'step 2', sortOrder: 1 },
    ]);
  });

  it('POST /templates/:tid/apply-to-list/:lid creates a new task with template content', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const tmpl = await prisma().template.create({
      data: {
        workspaceId: workspace.id, type: 'task' as any, name: 'Apply me',
        createdById: member.id, visibility: 'personal' as any,
        data: { title: 'New task title', description: 'desc', priority: 'urgent', dueDateOffsetDays: 3 } as any,
        versionHistory: [] as any,
      },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/templates/${tmpl.id}/apply-to-list/${list.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'New task title', priority: 'urgent', status: 'todo' });
    // dueDate roughly 3 days in the future.
    const dueDate = new Date(res.body.data.dueDate).getTime();
    expect(dueDate - Date.now()).toBeGreaterThan(2 * 86_400_000);
    expect(dueDate - Date.now()).toBeLessThan(4 * 86_400_000);
  });

  it('POST /lists/:lid/save-as-template + /templates/:tid/instantiate-list round-trip', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'A' });
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'B' });

    const save = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/lists/${list.id}/save-as-template`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'List tmpl' });
    expect(save.status).toBe(201);
    const tmplId = save.body.data.id;
    expect(save.body.data.data.tasks.length).toBe(2);

    const inst = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/templates/${tmplId}/instantiate-list`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'Cloned list' });
    expect(inst.status).toBe(201);
    expect(inst.body.data.name).toBe('Cloned list');

    // Two tasks created in the new list.
    const newListTasks = await prisma().task.findMany({ where: { listId: inst.body.data.id } });
    expect(newListTasks).toHaveLength(2);
    expect(newListTasks.map(t => t.title).sort()).toEqual(['A', 'B']);
    expect(newListTasks.every(t => t.source === 'template')).toBe(true);
  });

  it('apply-task-template fails 400 when template type is list', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const listTmpl = await prisma().template.create({
      data: { workspaceId: workspace.id, type: 'list' as any, name: 'L', createdById: member.id, visibility: 'personal' as any, data: { listName: 'X', tasks: [] } as any, versionHistory: [] as any },
    });
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/templates/${listTmpl.id}/apply-to-list/${list.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(400);
  });

  it('duplicate creates an independent copy (same data, different id)', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const tmpl = await prisma().template.create({
      data: { workspaceId: workspace.id, type: 'task' as any, name: 'Original', createdById: member.id, visibility: 'workspace' as any, data: { title: 'X' } as any, versionHistory: [] as any },
    });
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/templates/${tmpl.id}/duplicate`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(201);
    expect(res.body.data.id).not.toBe(tmpl.id);
    expect(res.body.data.data).toEqual({ title: 'X' });
  });
});
