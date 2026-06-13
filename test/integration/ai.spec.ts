import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect } from '../fixtures/db';
import { seedWorkspace } from '../fixtures/factories';
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
