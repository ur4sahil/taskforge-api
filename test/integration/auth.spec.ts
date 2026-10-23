import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createHash } from 'crypto';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { createUser } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';
import { EmailService } from '../../src/common/email/email.module';

let app: INestApplication;
let emailSvc: EmailService;
beforeAll(async () => { app = await bootstrapApp(); emailSvc = app.get(EmailService); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); jest.restoreAllMocks(); });

const srv = () => app.getHttpServer();
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

async function login(email: string, password: string) {
  const res = await request(srv()).post('/api/v1/auth/login').send({ email, password });
  return res;
}

// Seed a reset token row with a caller-chosen raw token (the real flow only
// ever puts the raw token in the email).
async function seedResetToken(userId: string, raw: string, opts: { expiresAt?: Date; usedAt?: Date | null } = {}) {
  return prisma().passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256(raw),
      expiresAt: opts.expiresAt || new Date(Date.now() + 60 * 60000),
      usedAt: opts.usedAt ?? null,
    },
  });
}

async function createGoogleUser(email = `google-${Date.now()}@test.local`) {
  return prisma().user.create({ data: { email, name: 'Google Person', authProvider: 'google', passwordHash: null } });
}

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

  describe('signup gate (internal tool: invite-only in production)', () => {
    const saved = { enabled: process.env.SIGNUP_ENABLED, env: process.env.NODE_ENV };
    afterEach(() => {
      if (saved.enabled === undefined) delete process.env.SIGNUP_ENABLED; else process.env.SIGNUP_ENABLED = saved.enabled;
      process.env.NODE_ENV = saved.env;
    });

    it('SIGNUP_ENABLED=false returns 403 and creates no user', async () => {
      process.env.SIGNUP_ENABLED = 'false';
      const email = uniqEmail('gated');
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send({ email, password: 'StrongPass123!', name: 'Gated' });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/invite-only/i);
      expect(await prisma().user.findUnique({ where: { email } })).toBeNull();
    });

    it('defaults to closed when NODE_ENV=production and SIGNUP_ENABLED is unset', async () => {
      delete process.env.SIGNUP_ENABLED;
      process.env.NODE_ENV = 'production';
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send({ email: uniqEmail('prod'), password: 'StrongPass123!', name: 'Prod' });
      expect(res.status).toBe(403);
    });

    it('SIGNUP_ENABLED=true re-opens signup even in production', async () => {
      process.env.SIGNUP_ENABLED = 'true';
      process.env.NODE_ENV = 'production';
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send({ email: uniqEmail('open'), password: 'StrongPass123!', name: 'Open' });
      expect(res.status).toBe(201);
    });
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

  it('refresh is rejected once the user account is deactivated', async () => {
    const { user, password } = await createUser();
    const { refreshToken } = (await login(user.email, password)).body.data;
    await prisma().user.update({ where: { id: user.id }, data: { isActive: false } });
    const r = await request(srv()).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(r.status).toBe(401);
  });

  it('logout prunes the user\'s revoked/expired refresh tokens older than 30 days but keeps recent ones', async () => {
    const { user, password } = await createUser();
    const { accessToken, refreshToken } = (await login(user.email, password)).body.data;
    const old = new Date(Date.now() - 40 * 86400000);
    const stale = await prisma().refreshToken.create({
      data: { userId: user.id, tokenHash: sha256('stale'), expiresAt: new Date(old.getTime() + 7 * 86400000), isRevoked: true, createdAt: old },
    });
    const recentRevoked = await prisma().refreshToken.create({
      data: { userId: user.id, tokenHash: sha256('recent'), expiresAt: new Date(Date.now() + 86400000), isRevoked: true },
    });
    // Another user's stale token must be untouched.
    const { user: other } = await createUser();
    const otherStale = await prisma().refreshToken.create({
      data: { userId: other.id, tokenHash: sha256('other-stale'), expiresAt: old, isRevoked: true, createdAt: old },
    });

    const out = await request(srv()).post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).send({ refreshToken });
    expect(out.status).toBe(200);

    expect(await prisma().refreshToken.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma().refreshToken.findUnique({ where: { id: recentRevoked.id } })).not.toBeNull();
    expect(await prisma().refreshToken.findUnique({ where: { id: otherStale.id } })).not.toBeNull();
  });
});

describe('Auth — forgot password', () => {
  const GENERIC = /if an account exists/i;

  it('unknown email: 200 with the generic message, no token row, no email', async () => {
    const spy = jest.spyOn(emailSvc, 'sendPasswordReset');
    const res = await request(srv()).post('/api/v1/auth/forgot-password').send({ email: uniqEmail('nobody') });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(GENERIC);
    expect(await prisma().passwordResetToken.count()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('known email: same 200 + message, stores sha256 of the token, emails a link carrying the raw token', async () => {
    const spy = jest.spyOn(emailSvc, 'sendPasswordReset');
    const { user } = await createUser({ name: 'Reset Me' });
    const unknown = await request(srv()).post('/api/v1/auth/forgot-password').send({ email: uniqEmail('nobody') });
    const known = await request(srv()).post('/api/v1/auth/forgot-password').send({ email: user.email.toUpperCase() });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body); // byte-identical response → no enumeration

    expect(spy).toHaveBeenCalledTimes(1);
    const [to, name, url, minutes] = spy.mock.calls[0];
    expect(to).toBe(user.email);
    expect(name).toBe('Reset Me');
    expect(minutes).toBe(60);
    const m = url.match(/^http:\/\/localhost:3000\/auth\/reset-password\/([0-9a-f]{64})$/);
    expect(m).not.toBeNull();
    const raw = m![1];

    const rows = await prisma().passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256(raw));
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(rows[0].usedAt).toBeNull();
    const ttl = rows[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60000);
    expect(ttl).toBeLessThanOrEqual(60 * 60000);
  });

  it('a second request invalidates the earlier unused token', async () => {
    const spy = jest.spyOn(emailSvc, 'sendPasswordReset');
    const { user } = await createUser();
    await request(srv()).post('/api/v1/auth/forgot-password').send({ email: user.email });
    await request(srv()).post('/api/v1/auth/forgot-password').send({ email: user.email });
    const first = spy.mock.calls[0][2].split('/').pop()!;
    const second = spy.mock.calls[1][2].split('/').pop()!;
    expect(first).not.toBe(second);
    expect((await request(srv()).get(`/api/v1/auth/reset-password/${first}`)).status).toBe(400);
    expect((await request(srv()).get(`/api/v1/auth/reset-password/${second}`)).status).toBe(200);
  });

  it('Google-only account: 200 + generic message, "uses Google" email, no token row', async () => {
    const reset = jest.spyOn(emailSvc, 'sendPasswordReset');
    const notice = jest.spyOn(emailSvc, 'sendPasswordResetNotApplicable');
    const g = await createGoogleUser();
    const res = await request(srv()).post('/api/v1/auth/forgot-password').send({ email: g.email });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(GENERIC);
    expect(reset).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(g.email, 'Google Person', 'http://localhost:3000/auth/login');
    expect(await prisma().passwordResetToken.count()).toBe(0);
  });

  it('deactivated account: 200 + generic message, nothing sent', async () => {
    const spy = jest.spyOn(emailSvc, 'sendPasswordReset');
    const { user } = await createUser();
    await prisma().user.update({ where: { id: user.id }, data: { isActive: false } });
    const res = await request(srv()).post('/api/v1/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(await prisma().passwordResetToken.count()).toBe(0);
  });

  it('malformed email → 400', async () => {
    const res = await request(srv()).post('/api/v1/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

describe('Auth — GET reset-password/:token', () => {
  it('valid token → { valid: true, email: masked }', async () => {
    const { user } = await createUser({ email: 'sahil@example.com' });
    await seedResetToken(user.id, 'good-token');
    const res = await request(srv()).get('/api/v1/auth/reset-password/good-token');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: true, email: 's***l@example.com' });
  });

  it('unknown token → 404', async () => {
    const res = await request(srv()).get('/api/v1/auth/reset-password/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('expired token → 400', async () => {
    const { user } = await createUser();
    await seedResetToken(user.id, 'expired-token', { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(srv()).get('/api/v1/auth/reset-password/expired-token');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('used token → 400', async () => {
    const { user } = await createUser();
    await seedResetToken(user.id, 'used-token', { usedAt: new Date() });
    const res = await request(srv()).get('/api/v1/auth/reset-password/used-token');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/used/i);
  });
});

describe('Auth — POST reset-password/:token', () => {
  it('sets the new password, marks the token used, revokes old refresh tokens, returns a session, and is single-use', async () => {
    const { user, password: oldPw } = await createUser();
    const { refreshToken: oldRefresh } = (await login(user.email, oldPw)).body.data;
    await seedResetToken(user.id, 'reset-ok');

    const res = await request(srv()).post('/api/v1/auth/reset-password/reset-ok').send({ password: 'BrandNewPass9!' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: expect.objectContaining({ id: user.id, email: user.email }),
      workspaces: expect.any(Array),
    });

    // Password actually changed.
    expect((await login(user.email, oldPw)).status).toBe(401);
    expect((await login(user.email, 'BrandNewPass9!')).status).toBe(200);
    const u = await prisma().user.findUnique({ where: { id: user.id } });
    expect(u!.passwordHash!.startsWith('$2')).toBe(true);
    expect(u!.passwordHash).not.toBe('BrandNewPass9!');

    // Token burned.
    const row = await prisma().passwordResetToken.findUnique({ where: { tokenHash: sha256('reset-ok') } });
    expect(row!.usedAt).not.toBeNull();

    // Pre-reset session dead; the returned one alive.
    expect((await request(srv()).post('/api/v1/auth/refresh').send({ refreshToken: oldRefresh })).status).toBe(401);
    expect((await request(srv()).post('/api/v1/auth/refresh').send({ refreshToken: res.body.data.refreshToken })).status).toBe(200);

    // Cannot be replayed.
    const again = await request(srv()).post('/api/v1/auth/reset-password/reset-ok').send({ password: 'AnotherPass77!' });
    expect(again.status).toBe(400);
    expect((await login(user.email, 'AnotherPass77!')).status).toBe(401);
  });

  it('unknown / expired tokens → 404 / 400 and the password is untouched', async () => {
    const { user, password } = await createUser();
    await seedResetToken(user.id, 'stale', { expiresAt: new Date(Date.now() - 1) });
    expect((await request(srv()).post('/api/v1/auth/reset-password/nope').send({ password: 'ValidPass123!' })).status).toBe(404);
    expect((await request(srv()).post('/api/v1/auth/reset-password/stale').send({ password: 'ValidPass123!' })).status).toBe(400);
    expect((await login(user.email, password)).status).toBe(200);
  });

  it('weak password → 400 and the token is NOT consumed', async () => {
    const { user } = await createUser();
    await seedResetToken(user.id, 'keep-me');
    const res = await request(srv()).post('/api/v1/auth/reset-password/keep-me').send({ password: 'short' });
    expect(res.status).toBe(400);
    const row = await prisma().passwordResetToken.findUnique({ where: { tokenHash: sha256('keep-me') } });
    expect(row!.usedAt).toBeNull();
  });

  it('deactivated account cannot reset → 401', async () => {
    const { user } = await createUser();
    await prisma().user.update({ where: { id: user.id }, data: { isActive: false } });
    await seedResetToken(user.id, 'inactive');
    const res = await request(srv()).post('/api/v1/auth/reset-password/inactive').send({ password: 'ValidPass123!' });
    expect(res.status).toBe(401);
  });
});

describe('Auth — change password', () => {
  it('wrong current password → 400, password unchanged, sessions intact', async () => {
    const { user, password } = await createUser();
    const { accessToken, refreshToken } = (await login(user.email, password)).body.data;
    const res = await request(srv()).post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'not-it-1234', newPassword: 'NewPassword55!' });
    expect(res.status).toBe(400);
    expect((await login(user.email, password)).status).toBe(200);
    expect((await request(srv()).post('/api/v1/auth/refresh').send({ refreshToken })).status).toBe(200);
  });

  it('correct current password → new pair returned, every old refresh token revoked, new password works', async () => {
    const { user, password } = await createUser();
    const s1 = (await login(user.email, password)).body.data;
    const s2 = (await login(user.email, password)).body.data; // second device
    const res = await request(srv()).post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${s1.accessToken}`)
      .send({ currentPassword: password, newPassword: 'NewPassword55!' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String) });

    expect((await request(srv()).post('/api/v1/auth/refresh').send({ refreshToken: s1.refreshToken })).status).toBe(401);
    expect((await request(srv()).post('/api/v1/auth/refresh').send({ refreshToken: s2.refreshToken })).status).toBe(401);
    expect((await request(srv()).post('/api/v1/auth/refresh').send({ refreshToken: res.body.data.refreshToken })).status).toBe(200);

    expect((await login(user.email, password)).status).toBe(401);
    expect((await login(user.email, 'NewPassword55!')).status).toBe(200);
  });

  it('weak new password → 400', async () => {
    const { user, password } = await createUser();
    const res = await request(srv()).post('/api/v1/auth/change-password')
      .set(authHeader(user.id, user.email))
      .send({ currentPassword: password, newPassword: 'short' });
    expect(res.status).toBe(400);
    expect((await login(user.email, password)).status).toBe(200);
  });

  it('Google-only account → 400', async () => {
    const g = await createGoogleUser();
    const res = await request(srv()).post('/api/v1/auth/change-password')
      .set(authHeader(g.id, g.email))
      .send({ currentPassword: 'whatever123', newPassword: 'NewPassword55!' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/google/i);
  });

  it('unauthenticated → 401', async () => {
    const res = await request(srv()).post('/api/v1/auth/change-password')
      .send({ currentPassword: 'a', newPassword: 'NewPassword55!' });
    expect(res.status).toBe(401);
  });
});
