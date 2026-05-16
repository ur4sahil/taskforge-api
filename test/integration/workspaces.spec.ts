import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('Workspaces', () => {
  it('GET /workspaces lists only the user\'s active workspaces', async () => {
    const { user, workspace } = await seedWorkspace();
    // Another workspace the user is NOT a member of.
    const otherOwner = await createUser();
    await prisma().workspace.create({
      data: { name: 'Outsider WS', slug: `outsider-${Date.now()}`, settings: {} },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/workspaces')
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: workspace.id, role: 'admin' });
    void otherOwner;
  });

  it('GET /workspaces/:wid returns the workspace for a member', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: workspace.id, name: workspace.name });
  });

  it('PATCH /workspaces/:wid as admin updates the name', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(authHeader(user.id, user.email))
      .send({ name: 'Renamed WS' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed WS');
  });

  it('PATCH /workspaces/:wid as employee returns 403', async () => {
    const { workspace } = await seedWorkspace();
    const { user: employee } = await createUser();
    await addMember(workspace.id, employee.id, 'employee');
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(authHeader(employee.id, employee.email))
      .send({ name: 'No way' });
    expect(res.status).toBe(403);
  });

  it('GET /workspaces/:wid/members lists members (paginated)', async () => {
    const { user, workspace } = await seedWorkspace();
    const { user: alice } = await createUser();
    const { user: bob } = await createUser();
    await addMember(workspace.id, alice.id, 'manager');
    await addMember(workspace.id, bob.id, 'employee');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/members`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
    expect(res.body.meta).toMatchObject({ total: 3, page: 1, totalPages: 1 });
  });

  describe('POST /workspaces/:wid/members (invite)', () => {
    it('creates a new user + member when email is unknown, returns tempPassword', async () => {
      const { user, workspace } = await seedWorkspace();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'newhire@example.com', name: 'New Hire', role: 'employee' });
      expect(res.status).toBe(201);
      expect(res.body.data.isNewUser).toBe(true);
      expect(typeof res.body.data.tempPassword).toBe('string');
      expect(res.body.data.tempPassword.length).toBeGreaterThanOrEqual(8);
      expect(res.body.data.member).toMatchObject({
        role: 'employee',
        isActive: true,
        user: { email: 'newhire@example.com', name: 'New Hire' },
      });
      // Member row must actually be linked to this workspace
      const dbMember = await prisma().workspaceMember.findFirst({
        where: { workspaceId: workspace.id, user: { email: 'newhire@example.com' } },
      });
      expect(dbMember).not.toBeNull();
    });

    it('links an existing user without creating a new one (tempPassword null)', async () => {
      const { user, workspace } = await seedWorkspace();
      const { user: alice } = await createUser({ email: 'alice@example.com' });
      const usersBefore = await prisma().user.count();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'alice@example.com', name: 'Alice (ignored)', role: 'manager' });
      expect(res.status).toBe(201);
      expect(res.body.data.isNewUser).toBe(false);
      expect(res.body.data.tempPassword).toBeNull();
      expect(res.body.data.member.role).toBe('manager');
      expect(res.body.data.member.userId).toBe(alice.id);

      const usersAfter = await prisma().user.count();
      expect(usersAfter).toBe(usersBefore); // no new user row created
    });

    it('returns 409 when user is already an active member', async () => {
      const { user, workspace } = await seedWorkspace();
      const { user: alice } = await createUser({ email: 'alice@example.com' });
      await addMember(workspace.id, alice.id, 'employee');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'alice@example.com', name: 'Alice', role: 'employee' });
      expect(res.status).toBe(409);
    });

    it('reactivates a previously-deactivated member instead of erroring', async () => {
      const { user, workspace } = await seedWorkspace();
      const { user: alice } = await createUser({ email: 'alice@example.com' });
      const existing = await addMember(workspace.id, alice.id, 'employee');
      await prisma().workspaceMember.update({ where: { id: existing.id }, data: { isActive: false } });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'alice@example.com', name: 'Alice', role: 'manager' });
      expect(res.status).toBe(201);
      expect(res.body.data.member.id).toBe(existing.id);
      expect(res.body.data.member.isActive).toBe(true);
      expect(res.body.data.member.role).toBe('manager');
    });

    it('rejects non-admin actors with 403', async () => {
      const { workspace } = await seedWorkspace();
      const { user: emp } = await createUser();
      await addMember(workspace.id, emp.id, 'employee');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(emp.id, emp.email))
        .send({ email: 'someone@example.com', name: 'Someone', role: 'employee' });
      expect(res.status).toBe(403);
    });

    it('sets WorkspaceMember.invitedBy to the inviting admin', async () => {
      const { user, workspace, member } = await seedWorkspace();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'who@example.com', name: 'New', role: 'employee' });
      expect(res.status).toBe(201);
      const row = await prisma().workspaceMember.findUnique({ where: { id: res.body.data.member.id } });
      expect(row!.invitedBy).toBe(member.id);
    });

    it('writes an audit log entry for the invite', async () => {
      const { user, workspace } = await seedWorkspace();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'audit-test@example.com', name: 'A', role: 'manager' });
      expect(res.status).toBe(201);
      // Audit interceptor writes asynchronously after the response; small wait.
      for (let i = 0; i < 10; i++) {
        const logs = await prisma().auditLog.findMany({ where: { workspaceId: workspace.id, action: 'member.invited' } });
        if (logs.length > 0) {
          expect(logs[0].entityType).toBe('workspaceMember');
          expect(logs[0].entityId).toBe(res.body.data.member.id);
          const changes = logs[0].changes as any;
          expect(changes.email).toBe('audit-test@example.com');
          expect(changes.role).toBe('manager');
          expect(changes.isNewUser).toBe(true);
          return;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('audit log row never appeared');
    });

    it('dispatches an `invite` notification visible to the new member', async () => {
      const { user, workspace } = await seedWorkspace();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'notify@example.com', name: 'Notify', role: 'employee' });
      expect(res.status).toBe(201);
      const notifs = await prisma().notification.findMany({
        where: { workspaceId: workspace.id, recipientId: res.body.data.member.id, type: 'invite' },
      });
      expect(notifs.length).toBe(1);
      expect(notifs[0].title).toMatch(/added to a workspace/i);
    });

    it('lowercases the email before lookup/storage', async () => {
      const { user, workspace } = await seedWorkspace();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(user.id, user.email))
        .send({ email: 'MixedCase@Example.COM', name: 'Mc', role: 'employee' });
      expect(res.status).toBe(201);
      expect(res.body.data.member.user.email).toBe('mixedcase@example.com');
    });
  });

  describe('POST /workspaces/:wid/members/:mid/rotate-password', () => {
    it('admin can rotate; returns new temp password; old password no longer logs in', async () => {
      const { user: admin, workspace } = await seedWorkspace();
      // Invite to create a member with a known temp password.
      const invite = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(admin.id, admin.email))
        .send({ email: 'rotate-me@example.com', name: 'R', role: 'employee' });
      const oldPw = invite.body.data.tempPassword as string;
      const newMid = invite.body.data.member.id;

      // Old password works:
      const before = await request(app.getHttpServer())
        .post('/api/v1/auth/login').send({ email: 'rotate-me@example.com', password: oldPw });
      expect(before.status).toBe(200);

      const rot = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members/${newMid}/rotate-password`)
        .set(authHeader(admin.id, admin.email));
      expect(rot.status).toBe(201);
      const newPw = rot.body.data.tempPassword as string;
      expect(newPw).not.toBe(oldPw);
      expect(rot.body.data.email).toBe('rotate-me@example.com');

      // Old password now rejected; new password accepted.
      const oldLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login').send({ email: 'rotate-me@example.com', password: oldPw });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login').send({ email: 'rotate-me@example.com', password: newPw });
      expect(newLogin.status).toBe(200);
    });

    it('rotation revokes all the user\'s active refresh tokens', async () => {
      const { user: admin, workspace } = await seedWorkspace();
      const invite = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members`)
        .set(authHeader(admin.id, admin.email))
        .send({ email: 'session-killed@example.com', name: 'S', role: 'employee' });
      const oldPw = invite.body.data.tempPassword as string;
      const newMid = invite.body.data.member.id;

      // Log in once so a refresh token exists.
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login').send({ email: 'session-killed@example.com', password: oldPw });
      const refreshToken = loginRes.body.data.refreshToken as string;

      // Refresh works before rotation.
      const before = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh').send({ refreshToken });
      expect(before.status).toBe(200);
      // The successful refresh just rotated the refresh token. Get the new one.
      const newRefresh = before.body.data.refreshToken as string;

      // Rotate password.
      await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members/${newMid}/rotate-password`)
        .set(authHeader(admin.id, admin.email));

      // Now the (currently-valid) refresh token must be rejected.
      const after = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh').send({ refreshToken: newRefresh });
      expect(after.status).toBe(401);
    });

    it('rejects rotation for Google OAuth accounts with 400', async () => {
      const { user: admin, workspace } = await seedWorkspace();
      // Manually create a google-only user + member.
      const googleUser = await prisma().user.create({
        data: { email: 'g@example.com', name: 'G', authProvider: 'google', passwordHash: null },
      });
      const m = await prisma().workspaceMember.create({
        data: { workspaceId: workspace.id, userId: googleUser.id, role: 'employee', isActive: true },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members/${m.id}/rotate-password`)
        .set(authHeader(admin.id, admin.email));
      expect(res.status).toBe(400);
    });

    it('non-admin cannot rotate (403)', async () => {
      const { workspace } = await seedWorkspace();
      const { user: emp } = await createUser();
      const empMember = await addMember(workspace.id, emp.id, 'employee');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members/${empMember.id}/rotate-password`)
        .set(authHeader(emp.id, emp.email));
      expect(res.status).toBe(403);
    });
  });

  it('non-member cannot access the workspace (403)', async () => {
    const { workspace } = await seedWorkspace();
    const { user: outsider } = await createUser();
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}`)
      .set(authHeader(outsider.id, outsider.email));
    expect([403, 404]).toContain(res.status);
  });
});
