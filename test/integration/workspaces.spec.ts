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

  // QA #10/#23/#50: the roster is a directory, not a feed — default to 200 a
  // page so pickers get everyone in one call, and carry isActive + managerId.
  describe('GET /workspaces/:wid/members paging + row shape', () => {
    it('defaults to perPage 200 with meta.total, caps at 500, and still honours an explicit perPage', async () => {
      const { user, workspace } = await seedWorkspace();
      for (let i = 0; i < 30; i++) { const { user: u } = await createUser(); await addMember(workspace.id, u.id, 'employee'); }

      const def = await request(app.getHttpServer()).get(`/api/v1/workspaces/${workspace.id}/members`).set(authHeader(user.id, user.email));
      expect(def.status).toBe(200);
      expect(def.body.data).toHaveLength(31);
      expect(def.body.meta).toEqual({ page: 1, perPage: 200, total: 31, totalPages: 1 });

      const small = await request(app.getHttpServer()).get(`/api/v1/workspaces/${workspace.id}/members?perPage=10&page=2`).set(authHeader(user.id, user.email));
      expect(small.body.data).toHaveLength(10);
      expect(small.body.meta).toEqual({ page: 2, perPage: 10, total: 31, totalPages: 4 });

      await request(app.getHttpServer()).get(`/api/v1/workspaces/${workspace.id}/members?perPage=501`).set(authHeader(user.id, user.email)).expect(400);
    });

    it('rows include isActive and managerId (and the manager name)', async () => {
      const { user, workspace, member: admin } = await seedWorkspace();
      const { user: mgrUser } = await createUser({ name: 'Boss' });
      const mgr = await addMember(workspace.id, mgrUser.id, 'manager');
      const { user: repUser } = await createUser();
      const rep = await addMember(workspace.id, repUser.id, 'employee', mgr.id);
      await prisma().workspaceMember.update({ where: { id: rep.id }, data: { isActive: false } });

      const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${workspace.id}/members`).set(authHeader(user.id, user.email));
      const byId = Object.fromEntries(res.body.data.map((m: any) => [m.id, m]));
      expect(byId[admin.id]).toMatchObject({ isActive: true, managerId: null, role: 'admin' });
      expect(byId[rep.id]).toMatchObject({ isActive: false, managerId: mgr.id, role: 'employee' });
      expect(byId[rep.id].manager.user.name).toBe('Boss');
      expect(byId[rep.id].user).toMatchObject({ id: repUser.id, email: repUser.email });
    });
  });

  it('GET /workspaces/:wid carries features.ai (false without ANTHROPIC_API_KEY)', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${workspace.id}`).set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: workspace.id, features: { ai: false } });
  });

  describe('POST /workspaces/:wid/members/:mid/rotate-password', () => {
    it('admin can rotate; returns new temp password; old password no longer logs in', async () => {
      const { user: admin, workspace } = await seedWorkspace();
      const { user: target, password: oldPw } = await createUser({ email: 'rotate-me@example.com' });
      const newMid = (await addMember(workspace.id, target.id, 'employee')).id;

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
      const { user: target, password: oldPw } = await createUser({ email: 'session-killed@example.com' });
      const newMid = (await addMember(workspace.id, target.id, 'employee')).id;

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

  it('admin PATCH members/:mid rejects an invalid timezone (same rule as /me)', async () => {
    const { user, workspace } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const bad = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/members/${empMember.id}`)
      .set(authHeader(user.id, user.email))
      .send({ timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    const ok = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/members/${empMember.id}`)
      .set(authHeader(user.id, user.email))
      .send({ timezone: 'America/Chicago' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.timezone).toBe('America/Chicago');
  });

  describe('PATCH /workspaces/:wid/members/me (own timezone)', () => {
    it('an employee sets their own timezone to a valid IANA zone', async () => {
      const { workspace } = await seedWorkspace();
      const { user: emp } = await createUser();
      const empMember = await addMember(workspace.id, emp.id, 'employee');
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/workspaces/${workspace.id}/members/me`)
        .set(authHeader(emp.id, emp.email))
        .send({ timezone: 'America/Los_Angeles' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: empMember.id, timezone: 'America/Los_Angeles' });
      const row = await prisma().workspaceMember.findUnique({ where: { id: empMember.id } });
      expect(row!.timezone).toBe('America/Los_Angeles');
    });

    it('rejects a non-IANA zone with 400 and leaves the row unchanged', async () => {
      const { user, workspace, member } = await seedWorkspace();
      for (const bad of ['Mars/Olympus', 'EST5EDT-garbage', '']) {
        const res = await request(app.getHttpServer())
          .patch(`/api/v1/workspaces/${workspace.id}/members/me`)
          .set(authHeader(user.id, user.email))
          .send({ timezone: bad });
        expect(res.status).toBe(400);
      }
      const row = await prisma().workspaceMember.findUnique({ where: { id: member.id } });
      expect(row!.timezone).toBe('UTC');
    });

    it('"me" is not captured by the admin :mid route: an admin PATCHing members/me updates their OWN row', async () => {
      const { user: admin, workspace, member: adminMember } = await seedWorkspace();
      const { user: emp } = await createUser();
      const empMember = await addMember(workspace.id, emp.id, 'employee');
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/workspaces/${workspace.id}/members/me`)
        .set(authHeader(admin.id, admin.email))
        .send({ timezone: 'Europe/London', role: 'employee' }); // role is not whitelisted here
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(adminMember.id);
      const adminRow = await prisma().workspaceMember.findUnique({ where: { id: adminMember.id } });
      expect(adminRow).toMatchObject({ timezone: 'Europe/London', role: 'admin' });
      const empRow = await prisma().workspaceMember.findUnique({ where: { id: empMember.id } });
      expect(empRow!.timezone).toBe('UTC');
    });

    it('non-member → 403', async () => {
      const { workspace } = await seedWorkspace();
      const { user: outsider } = await createUser();
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/workspaces/${workspace.id}/members/me`)
        .set(authHeader(outsider.id, outsider.email))
        .send({ timezone: 'UTC' });
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /workspaces/:wid/members/:mid (admin)', () => {
    it('admin still changes another member\'s role and timezone', async () => {
      const { user: admin, workspace } = await seedWorkspace();
      const { user: emp } = await createUser();
      const empMember = await addMember(workspace.id, emp.id, 'employee');
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/workspaces/${workspace.id}/members/${empMember.id}`)
        .set(authHeader(admin.id, admin.email))
        .send({ role: 'manager', timezone: 'Asia/Kolkata' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: empMember.id, role: 'manager', timezone: 'Asia/Kolkata' });
    });

    it('employee cannot PATCH another member (403)', async () => {
      const { workspace, member: adminMember } = await seedWorkspace();
      const { user: emp } = await createUser();
      await addMember(workspace.id, emp.id, 'employee');
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set(authHeader(emp.id, emp.email))
        .send({ role: 'employee' });
      expect(res.status).toBe(403);
    });

    it('refuses to demote the only active admin (400); allowed once another admin exists', async () => {
      const { user: admin, workspace, member: adminMember } = await seedWorkspace();
      const demote = () => request(app.getHttpServer())
        .patch(`/api/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set(authHeader(admin.id, admin.email))
        .send({ role: 'manager' });

      const blocked = await demote();
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.message).toMatch(/only active admin/i);
      expect((await prisma().workspaceMember.findUnique({ where: { id: adminMember.id } }))!.role).toBe('admin');

      // An inactive admin does not count.
      const { user: ghost } = await createUser();
      const ghostAdmin = await addMember(workspace.id, ghost.id, 'admin');
      await prisma().workspaceMember.update({ where: { id: ghostAdmin.id }, data: { isActive: false } });
      expect((await demote()).status).toBe(400);

      const { user: second } = await createUser();
      await addMember(workspace.id, second.id, 'admin');
      const ok = await demote();
      expect(ok.status).toBe(200);
      expect(ok.body.data.role).toBe('manager');
    });

    it('admin → admin "change" on the only admin is a no-op, not a 400', async () => {
      const { user: admin, workspace, member: adminMember } = await seedWorkspace();
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/workspaces/${workspace.id}/members/${adminMember.id}`)
        .set(authHeader(admin.id, admin.email))
        .send({ role: 'admin' });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /workspaces/:wid/members/:mid/deactivate', () => {
    it('revokes the deactivated user\'s refresh tokens', async () => {
      const { user: admin, workspace } = await seedWorkspace();
      const { user: target, password } = await createUser();
      const targetMember = await addMember(workspace.id, target.id, 'employee');
      const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: target.email, password });
      const refreshToken = loginRes.body.data.refreshToken as string;

      const res = await request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members/${targetMember.id}/deactivate`)
        .set(authHeader(admin.id, admin.email));
      expect(res.status).toBe(201);
      expect(res.body.data.isActive).toBe(false);

      const after = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken });
      expect(after.status).toBe(401);
      const live = await prisma().refreshToken.count({ where: { userId: target.id, isRevoked: false } });
      expect(live).toBe(0);
    });

    it('refuses to deactivate the only active admin (400); allowed once another admin exists', async () => {
      const { user: admin, workspace, member: adminMember } = await seedWorkspace();
      const deactivate = () => request(app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.id}/members/${adminMember.id}/deactivate`)
        .set(authHeader(admin.id, admin.email));

      const blocked = await deactivate();
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.message).toMatch(/only active admin/i);
      expect((await prisma().workspaceMember.findUnique({ where: { id: adminMember.id } }))!.isActive).toBe(true);

      const { user: second } = await createUser();
      await addMember(workspace.id, second.id, 'admin');
      const ok = await deactivate();
      expect(ok.status).toBe(201);
      expect(ok.body.data.isActive).toBe(false);
    });
  });
});
