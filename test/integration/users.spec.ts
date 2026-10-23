import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { createUser } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

describe('Users — GET /users/me', () => {
  it('returns the caller\'s profile and nothing sensitive', async () => {
    const { user } = await createUser({ name: 'Profile Person' });
    const res = await request(srv()).get('/api/v1/users/me').set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: user.id,
      email: user.email,
      name: 'Profile Person',
      authProvider: 'email',
      createdAt: user.createdAt.toISOString(),
      features: { ai: false },
    });
    expect(res.body.data).not.toHaveProperty('passwordHash');
  });

  // QA #38: the web decides whether to show the AI panel from this flag, which
  // is derived from ANTHROPIC_API_KEY on the server (unset in the test env).
  it('features.ai is false without ANTHROPIC_API_KEY and true with it', async () => {
    const { user } = await createUser();
    const off = await request(srv()).get('/api/v1/users/me').set(authHeader(user.id, user.email));
    expect(off.body.data.features).toEqual({ ai: false });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const keyed = await bootstrapApp();
    try {
      const on = await request(keyed.getHttpServer()).get('/api/v1/users/me').set(authHeader(user.id, user.email));
      expect(on.body.data.features).toEqual({ ai: true });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      await keyed.close();
    }
  });

  it('reports authProvider=google for a Google account', async () => {
    const g = await prisma().user.create({ data: { email: 'g-me@test.local', name: 'G', authProvider: 'google', passwordHash: null } });
    const res = await request(srv()).get('/api/v1/users/me').set(authHeader(g.id, g.email));
    expect(res.status).toBe(200);
    expect(res.body.data.authProvider).toBe('google');
  });

  it('unauthenticated → 401', async () => {
    expect((await request(srv()).get('/api/v1/users/me')).status).toBe(401);
  });

  it('deactivated user → 401 (JWT strategy refuses inactive accounts)', async () => {
    const { user } = await createUser();
    await prisma().user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await request(srv()).get('/api/v1/users/me').set(authHeader(user.id, user.email))).status).toBe(401);
  });
});

describe('Users — PATCH /users/me', () => {
  it('updates the name (trimmed) and persists it', async () => {
    const { user } = await createUser();
    const res = await request(srv()).patch('/api/v1/users/me')
      .set(authHeader(user.id, user.email))
      .send({ name: '  New Name  ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, name: 'New Name' });
    expect((await prisma().user.findUnique({ where: { id: user.id } }))!.name).toBe('New Name');
  });

  it('accepts a 100-char name and rejects 101', async () => {
    const { user } = await createUser();
    const ok = await request(srv()).patch('/api/v1/users/me').set(authHeader(user.id, user.email)).send({ name: 'a'.repeat(100) });
    expect(ok.status).toBe(200);
    const tooLong = await request(srv()).patch('/api/v1/users/me').set(authHeader(user.id, user.email)).send({ name: 'a'.repeat(101) });
    expect(tooLong.status).toBe(400);
  });

  it('rejects empty / whitespace-only / missing / null names with 400', async () => {
    const { user } = await createUser({ name: 'Keep Me' });
    // Note: a numeric name (e.g. 42) is coerced to '42' by the global
    // ValidationPipe's enableImplicitConversion, same as every other DTO.
    for (const body of [{ name: '' }, { name: '   ' }, {}, { name: null }]) {
      const res = await request(srv()).patch('/api/v1/users/me').set(authHeader(user.id, user.email)).send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect((await prisma().user.findUnique({ where: { id: user.id } }))!.name).toBe('Keep Me');
  });

  it('ignores non-whitelisted fields: email and authProvider cannot be changed here', async () => {
    const { user } = await createUser();
    const res = await request(srv()).patch('/api/v1/users/me')
      .set(authHeader(user.id, user.email))
      .send({ name: 'Legit', email: 'hijack@test.local', authProvider: 'google', isActive: false });
    expect(res.status).toBe(200);
    const row = await prisma().user.findUnique({ where: { id: user.id } });
    expect(row).toMatchObject({ name: 'Legit', email: user.email, authProvider: 'email', isActive: true });
  });

  it('unauthenticated → 401', async () => {
    expect((await request(srv()).patch('/api/v1/users/me').send({ name: 'X' })).status).toBe(401);
  });
});
