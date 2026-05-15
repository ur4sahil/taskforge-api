import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { createUser } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

function uniqEmail(prefix = 'auth') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

describe('Auth', () => {
  it('signup creates a user and returns access + refresh tokens', async () => {
    const email = uniqEmail('signup');
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ email, password: 'StrongPass123!', name: 'Signup User' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      data: expect.objectContaining({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: expect.objectContaining({ email, name: 'Signup User' }),
        workspaces: [],
      }),
    });

    const created = await prisma().user.findUnique({ where: { email } });
    expect(created).not.toBeNull();
  });

  it('signup with existing email returns 409', async () => {
    const { user } = await createUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ email: user.email, password: 'StrongPass123!', name: 'Dup' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, error: { code: 409 } });
  });

  it('login with correct password works and returns workspaces array', async () => {
    const { user, password } = await createUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(Array.isArray(res.body.data.workspaces)).toBe(true);
  });

  it('login with wrong password returns 401', async () => {
    const { user } = await createUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'wrongPass1!' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('login with non-existent email returns 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: uniqEmail('ghost'), password: 'whatever123' });
    expect(res.status).toBe(401);
  });

  it('refresh with valid refresh token returns a new access + refresh token pair', async () => {
    const { user, password } = await createUser();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login').send({ email: user.email, password });
    const { refreshToken, accessToken: oldAccess } = login.body.data;

    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh').send({ refreshToken });
    expect(r.status).toBe(200);
    expect(r.body.data.accessToken).toEqual(expect.any(String));
    expect(r.body.data.refreshToken).toEqual(expect.any(String));
    // NOTE: access tokens minted in the same second have identical iat/exp, so they may
    // be byte-identical. The refresh token (40 random bytes) is always new.
    expect(r.body.data.refreshToken).not.toBe(refreshToken);
    void oldAccess;
  });

  it('refresh with invalid token returns 401', async () => {
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh').send({ refreshToken: 'totally-bogus-token' });
    expect(r.status).toBe(401);
  });

  it('refresh with revoked/used token returns 401 (rotation)', async () => {
    const { user, password } = await createUser();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login').send({ email: user.email, password });
    const { refreshToken } = login.body.data;

    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);

    // Reuse the original refresh token — should now be revoked.
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh').send({ refreshToken });
    expect(second.status).toBe(401);
  });

  it('logout invalidates the refresh token; subsequent refresh fails', async () => {
    const { user, password } = await createUser();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login').send({ email: user.email, password });
    const { accessToken, refreshToken } = login.body.data;

    const out = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(out.status).toBe(200);

    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh').send({ refreshToken });
    expect(r.status).toBe(401);
  });

  it('signup stores a bcrypt hash, never the plaintext password', async () => {
    const email = uniqEmail('hash');
    const password = 'SuperSecret!42';
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup').send({ email, password, name: 'Hash User' });
    expect(res.status).toBe(201);
    const u = await prisma().user.findUnique({ where: { email } });
    expect(u).not.toBeNull();
    expect(u!.passwordHash).not.toBe(password);
    expect(u!.passwordHash!.startsWith('$2')).toBe(true);
  });
});
