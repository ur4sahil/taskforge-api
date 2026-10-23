import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect } from '../fixtures/db';
import { seedWorkspace, createUser, createWorkspace, addMember, createList, createTask, addListMember } from '../fixtures/factories';
import { prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';

// These exercise the controller + the graceful no-key fallback paths. The test
// env has no ANTHROPIC_API_KEY, so the service short-circuits before any network
// call. The with-key branches (real fetch + parsing) are covered in the
// ai.service unit spec with a mocked fetch.

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

describe('AI endpoints (no API key configured)', () => {
  it('chat returns the not-configured fallback message', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/ai/chat`)
      .set(authHeader(user.id, user.email))
      .send({ message: 'What should I work on?' });
    expect(res.status).toBe(201);
    expect(res.body.data.response).toMatch(/not configured/i);
  });

  it('parse-task echoes the input with zero confidence', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/ai/parse-task`)
      .set(authHeader(user.id, user.email))
      .send({ input: 'Call the plumber tomorrow' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Call the plumber tomorrow', confidence: 0 });
  });

  it('rejects an empty chat message with 400', async () => {
    const { user, workspace } = await seedWorkspace();
    await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/ai/chat`)
      .set(authHeader(user.id, user.email))
      .send({ message: '' })
      .expect(400);
  });

  it('rejects unauthenticated access with 401', async () => {
    const { workspace } = await seedWorkspace();
    await request(srv()).post(`/api/v1/workspaces/${workspace.id}/ai/chat`).send({ message: 'hi' }).expect(401);
  });
});

// ───────────────────────── With a key: context scoping ─────────────────────────
// A second app is booted with ANTHROPIC_API_KEY set (the config factory reads
// process.env at module compile). global.fetch is stubbed so no network call is
// made; we capture the request body and inspect the system prompt.
describe('AI chat context scoping (API key configured, Anthropic call mocked)', () => {
  let keyedApp: INestApplication;
  const originalFetch = global.fetch;
  let captured: any[] = [];

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    keyedApp = await bootstrapApp();
  });
  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    global.fetch = originalFetch;
    await keyedApp.close();
  });
  beforeEach(() => {
    captured = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      captured.push(JSON.parse(init.body));
      return { json: async () => ({ content: [{ text: 'ok' }] }) };
    }) as any;
  });

  const systemPrompt = () => captured[0].system as string;

  it('employee prompt contains only tasks from lists they can access; archived and trashed tasks are never included', async () => {
    const { user: adminUser } = await createUser();
    const { workspace, member: adminMember } = await createWorkspace({ ownerUserId: adminUser.id });
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const mine = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'mine' });
    await addListMember(mine.id, empMember.id, adminMember.id);
    const hidden = await createList({ workspaceId: workspace.id, createdById: adminMember.id, name: 'hidden' });

    await createTask({ workspaceId: workspace.id, listId: mine.id, creatorId: adminMember.id, title: 'VISIBLE_TASK' });
    await createTask({ workspaceId: workspace.id, listId: hidden.id, creatorId: adminMember.id, title: 'HIDDEN_TASK' });
    await createTask({ workspaceId: workspace.id, listId: mine.id, creatorId: adminMember.id, title: 'ARCHIVED_TASK', archivedAt: new Date() });
    const trashed = await createTask({ workspaceId: workspace.id, listId: mine.id, creatorId: adminMember.id, title: 'TRASHED_TASK' });
    await prisma().task.update({ where: { id: trashed.id }, data: { deletedAt: new Date() } });

    const res = await request(keyedApp.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/ai/chat`)
      .set(authHeader(emp.id, emp.email))
      .send({ message: 'What should I do?' });
    expect(res.status).toBe(201);
    expect(res.body.data.response).toBe('ok');
    expect(captured).toHaveLength(1);
    const prompt = systemPrompt();
    expect(prompt).toContain('VISIBLE_TASK');
    expect(prompt).not.toContain('HIDDEN_TASK');
    expect(prompt).not.toContain('ARCHIVED_TASK');
    expect(prompt).not.toContain('TRASHED_TASK');

    // Admin sees the hidden list's task too, but still never archived/trashed.
    const asAdmin = await request(keyedApp.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/ai/chat`)
      .set(authHeader(adminUser.id, adminUser.email))
      .send({ message: 'Summarize' });
    expect(asAdmin.status).toBe(201);
    const adminPrompt = captured[1].system as string;
    expect(adminPrompt).toContain('VISIBLE_TASK');
    expect(adminPrompt).toContain('HIDDEN_TASK');
    expect(adminPrompt).not.toContain('ARCHIVED_TASK');
    expect(adminPrompt).not.toContain('TRASHED_TASK');
  });

  it('employee on no lists gets an empty context, never the whole workspace', async () => {
    const { user: adminUser } = await createUser();
    const { workspace, member: adminMember } = await createWorkspace({ ownerUserId: adminUser.id });
    const { user: emp } = await createUser();
    await addMember(workspace.id, emp.id, 'employee');
    const list = await createList({ workspaceId: workspace.id, createdById: adminMember.id });
    await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id, title: 'WORKSPACE_ONLY_TASK' });

    const res = await request(keyedApp.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/ai/chat`)
      .set(authHeader(emp.id, emp.email))
      .send({ message: 'hi' });
    expect(res.status).toBe(201);
    expect(systemPrompt()).not.toContain('WORKSPACE_ONLY_TASK');
    expect(systemPrompt()).toContain('Context: []');
  });
});
