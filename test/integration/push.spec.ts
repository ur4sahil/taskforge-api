import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } });

describe('Push subscriptions', () => {
  it('subscribe stores a push subscription row for the member', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/push/subscribe`)
      .set(authHeader(user.id, user.email))
      .send(sub('https://push.example.com/abc'));
    expect(res.status).toBe(201);
    const rows = await prisma().pushSubscription.findMany({ where: { workspaceMemberId: member.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe('https://push.example.com/abc');
  });

  it('subscribe is idempotent on endpoint (re-subscribe updates, not duplicates)', async () => {
    const { user, workspace } = await seedWorkspace();
    const headers = authHeader(user.id, user.email);
    await request(srv()).post(`/api/v1/workspaces/${workspace.id}/push/subscribe`).set(headers).send(sub('https://push.example.com/same')).expect(201);
    await request(srv()).post(`/api/v1/workspaces/${workspace.id}/push/subscribe`).set(headers).send(sub('https://push.example.com/same')).expect(201);
    expect(await prisma().pushSubscription.count({ where: { endpoint: 'https://push.example.com/same' } })).toBe(1);
  });

  it('unsubscribe deletes the subscription by endpoint', async () => {
    const { user, workspace, member } = await seedWorkspace();
    await prisma().pushSubscription.create({ data: { workspaceMemberId: member.id, endpoint: 'https://push.example.com/del', p256dh: 'x', authKey: 'y' } });
    const res = await request(srv())
      .delete(`/api/v1/workspaces/${workspace.id}/push/subscribe`)
      .set(authHeader(user.id, user.email))
      .send({ endpoint: 'https://push.example.com/del' });
    expect(res.status).toBe(200);
    expect(await prisma().pushSubscription.count({ where: { endpoint: 'https://push.example.com/del' } })).toBe(0);
  });

  it('public-key returns the configured VAPID public key (empty string when unset)', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/push/public-key`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('publicKey');
  });

  it('test endpoint succeeds even when push is not configured (no-op send)', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/push/test`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ ok: true });
  });

  it('rejects a subscribe payload missing the endpoint with 400', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/push/subscribe`)
      .set(authHeader(user.id, user.email))
      .send({ keys: { p256dh: 'a', auth: 'b' } });
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated access with 401', async () => {
    const { workspace } = await seedWorkspace();
    await request(srv()).post(`/api/v1/workspaces/${workspace.id}/push/subscribe`).send(sub('https://x')).expect(401);
  });
});
