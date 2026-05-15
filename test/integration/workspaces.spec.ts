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

  it('non-member cannot access the workspace (403)', async () => {
    const { workspace } = await seedWorkspace();
    const { user: outsider } = await createUser();
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}`)
      .set(authHeader(outsider.id, outsider.email));
    expect([403, 404]).toContain(res.status);
  });
});
