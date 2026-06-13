import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createHash } from 'crypto';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { createUser, createWorkspace, addMember } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

// Mirror src/modules/invitations hashToken — we need it to seed rows with a
// known plaintext token so the public preview/accept flows can be exercised
// (the real flow only ever leaks the plaintext into the invite email).
function hashToken(t: string) {
  return createHash('sha256').update(t).digest('hex');
}

// Insert an invitation row directly with a caller-chosen plaintext token.
async function seedInvitation(opts: {
  workspaceId: string;
  invitedBy: string;
  email: string;
  name?: string;
  token: string;
  role?: 'admin' | 'manager' | 'employee';
  managerId?: string | null;
  expiresAt?: Date;
  acceptedAt?: Date | null;
}) {
  return prisma().invitation.create({
    data: {
      workspaceId: opts.workspaceId,
      invitedBy: opts.invitedBy,
      email: opts.email.toLowerCase(),
      name: opts.name || 'Invitee',
      role: (opts.role || 'employee') as any,
      managerId: opts.managerId ?? null,
      tokenHash: hashToken(opts.token),
      expiresAt: opts.expiresAt || new Date(Date.now() + 7 * 86400000),
      acceptedAt: opts.acceptedAt ?? null,
    },
  });
}

// Admin owner + workspace, ready to call the admin endpoints.
async function seedAdmin() {
  const { user } = await createUser({ name: 'Admin Owner' });
  const { workspace, member } = await createWorkspace({ ownerUserId: user.id, ownerRole: 'admin' });
  return { user, workspace, member, headers: authHeader(user.id, user.email) };
}

describe('Invitations — admin create', () => {
  it('admin creates an invitation: 201, sanitized payload (no token hash), lowercased email, default employee role', async () => {
    const { workspace, headers } = await seedAdmin();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(headers)
      .send({ email: 'NewHire@Example.com', name: '  New Hire  ' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      email: 'newhire@example.com',
      name: 'New Hire',
      role: 'employee',
      acceptedAt: null,
    });
    expect(res.body.data.tokenHash).toBeUndefined();

    const row = await prisma().invitation.findFirst({ where: { workspaceId: workspace.id, email: 'newhire@example.com' } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toEqual(expect.any(String));
    expect(row!.acceptedAt).toBeNull();
  });

  it('respects an explicit role', async () => {
    const { workspace, headers } = await seedAdmin();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(headers)
      .send({ email: 'mgr@example.com', name: 'Manager', role: 'manager' });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('manager');
  });

  it('returns 409 when the invitee is already an active member', async () => {
    const { workspace, headers } = await seedAdmin();
    const { user: existing } = await createUser({ email: 'already@example.com' });
    await addMember(workspace.id, existing.id, 'employee');

    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(headers)
      .send({ email: 'already@example.com', name: 'Dup' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('re-inviting the same email supersedes the prior pending invite (only one pending row remains)', async () => {
    const { workspace, headers } = await seedAdmin();
    await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(headers).send({ email: 'twice@example.com', name: 'First' }).expect(201);
    await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(headers).send({ email: 'twice@example.com', name: 'Second' }).expect(201);

    const rows = await prisma().invitation.findMany({ where: { workspaceId: workspace.id, email: 'twice@example.com', acceptedAt: null } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Second');
  });

  it('rejects invalid email payloads with 400', async () => {
    const { workspace, headers } = await seedAdmin();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(headers).send({ email: 'not-an-email', name: 'X' });
    expect(res.status).toBe(400);
  });

  it('returns 403 for a non-admin member', async () => {
    const { workspace } = await seedAdmin();
    const { user: emp } = await createUser({ email: 'emp@example.com' });
    await addMember(workspace.id, emp.id, 'employee');
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(authHeader(emp.id, emp.email))
      .send({ email: 'x@example.com', name: 'X' });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const { workspace } = await seedAdmin();
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations`)
      .send({ email: 'x@example.com', name: 'X' });
    expect(res.status).toBe(401);
  });
});

describe('Invitations — admin list', () => {
  it('lists only pending (not accepted, not expired) invitations with the inviter name', async () => {
    const { workspace, member, headers } = await seedAdmin();
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'pending@example.com', token: 'tok-pending' });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'accepted@example.com', token: 'tok-accepted', acceptedAt: new Date() });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'expired@example.com', token: 'tok-expired', expiresAt: new Date(Date.now() - 86400000) });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/invitations`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ email: 'pending@example.com', inviterName: 'Admin Owner' });
    expect(res.body.data[0].tokenHash).toBeUndefined();
  });
});

describe('Invitations — admin revoke', () => {
  it('revokes a pending invitation and removes the row', async () => {
    const { workspace, member, headers } = await seedAdmin();
    const inv = await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'revoke@example.com', token: 'tok-revoke' });
    const res = await request(srv())
      .delete(`/api/v1/workspaces/${workspace.id}/invitations/${inv.id}`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(await prisma().invitation.findUnique({ where: { id: inv.id } })).toBeNull();
  });

  it('returns 400 when revoking an already-accepted invitation', async () => {
    const { workspace, member, headers } = await seedAdmin();
    const inv = await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'acc@example.com', token: 'tok-acc', acceptedAt: new Date() });
    const res = await request(srv())
      .delete(`/api/v1/workspaces/${workspace.id}/invitations/${inv.id}`)
      .set(headers);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent invitation', async () => {
    const { workspace, headers } = await seedAdmin();
    const res = await request(srv())
      .delete(`/api/v1/workspaces/${workspace.id}/invitations/00000000-0000-0000-0000-000000000000`)
      .set(headers);
    expect(res.status).toBe(404);
  });
});

describe('Invitations — admin resend', () => {
  it('rotates the token: the old plaintext token stops working, the row persists', async () => {
    const { workspace, member, headers } = await seedAdmin();
    const inv = await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'resend@example.com', token: 'old-token' });
    const oldHash = inv.tokenHash;

    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations/${inv.id}/resend`)
      .set(headers);
    expect(res.status).toBe(201);

    const updated = await prisma().invitation.findUnique({ where: { id: inv.id } });
    expect(updated).not.toBeNull();
    expect(updated!.tokenHash).not.toBe(oldHash);

    // Old token no longer previews.
    await request(srv()).get('/api/v1/invitations/preview/old-token').expect(404);
  });

  it('returns 400 when resending an already-accepted invitation', async () => {
    const { workspace, member, headers } = await seedAdmin();
    const inv = await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'r@example.com', token: 't', acceptedAt: new Date() });
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/invitations/${inv.id}/resend`)
      .set(headers);
    expect(res.status).toBe(400);
  });
});

describe('Invitations — public preview', () => {
  it('returns workspace + inviter context for a valid token; userExists=false for a brand-new email', async () => {
    const { workspace, member } = await seedAdmin();
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'preview@example.com', name: 'Pat', token: 'preview-tok', role: 'manager' });

    const res = await request(srv()).get('/api/v1/invitations/preview/preview-tok');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      workspaceName: workspace.name,
      inviterName: 'Admin Owner',
      inviteeEmail: 'preview@example.com',
      inviteeName: 'Pat',
      role: 'manager',
      userExists: false,
    });
  });

  it('reports userExists=true when the invitee email already has an account', async () => {
    const { workspace, member } = await seedAdmin();
    await createUser({ email: 'has-account@example.com' });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'has-account@example.com', token: 'exists-tok' });
    const res = await request(srv()).get('/api/v1/invitations/preview/exists-tok');
    expect(res.status).toBe(200);
    expect(res.body.data.userExists).toBe(true);
  });

  it('returns 404 for an unknown token', async () => {
    await request(srv()).get('/api/v1/invitations/preview/nope').expect(404);
  });

  it('returns 400 for an expired token', async () => {
    const { workspace, member } = await seedAdmin();
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'exp@example.com', token: 'expired-tok', expiresAt: new Date(Date.now() - 1000) });
    await request(srv()).get('/api/v1/invitations/preview/expired-tok').expect(400);
  });

  it('returns 400 for an already-accepted token', async () => {
    const { workspace, member } = await seedAdmin();
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'done@example.com', token: 'done-tok', acceptedAt: new Date() });
    await request(srv()).get('/api/v1/invitations/preview/done-tok').expect(400);
  });
});

describe('Invitations — public accept', () => {
  it('new user: creates the account + active membership, marks accepted, returns a session', async () => {
    const { workspace, member } = await seedAdmin();
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'fresh@example.com', name: 'Fresh', token: 'accept-new', role: 'manager' });

    const res = await request(srv())
      .post('/api/v1/invitations/accept/accept-new')
      .send({ password: 'BrandNewPass1!' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: expect.objectContaining({ email: 'fresh@example.com' }),
    });
    expect(res.body.data.workspaces.map((w: any) => w.id)).toContain(workspace.id);

    const u = await prisma().user.findUnique({ where: { email: 'fresh@example.com' } });
    expect(u).not.toBeNull();
    expect(u!.passwordHash!.startsWith('$2')).toBe(true);
    const m = await prisma().workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: u!.id } });
    expect(m).toMatchObject({ isActive: true, role: 'manager' });
    const inv = await prisma().invitation.findFirst({ where: { tokenHash: hashToken('accept-new') } });
    expect(inv!.acceptedAt).not.toBeNull();
  });

  it('existing account + correct password: joins the workspace without changing the password', async () => {
    const { workspace, member } = await seedAdmin();
    const { user: existing } = await createUser({ email: 'existing@example.com', password: 'MyExisting1!' });
    const before = await prisma().user.findUnique({ where: { id: existing.id } });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'existing@example.com', token: 'accept-existing' });

    const res = await request(srv())
      .post('/api/v1/invitations/accept/accept-existing')
      .send({ password: 'MyExisting1!' });
    expect(res.status).toBe(201);

    const after = await prisma().user.findUnique({ where: { id: existing.id } });
    expect(after!.passwordHash).toBe(before!.passwordHash);
    const m = await prisma().workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: existing.id } });
    expect(m!.isActive).toBe(true);
  });

  it('existing account + wrong password: 401 and no membership created', async () => {
    const { workspace, member } = await seedAdmin();
    const { user: existing } = await createUser({ email: 'wrongpw@example.com', password: 'Correct1!' });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'wrongpw@example.com', token: 'accept-wrong' });

    const res = await request(srv())
      .post('/api/v1/invitations/accept/accept-wrong')
      .send({ password: 'Incorrect9!' });
    expect(res.status).toBe(401);
    const m = await prisma().workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: existing.id } });
    expect(m).toBeNull();
  });

  it('reactivates a previously-deactivated membership', async () => {
    const { workspace, member } = await seedAdmin();
    const { user: existing } = await createUser({ email: 'rejoin@example.com', password: 'Rejoin1!' });
    const m = await addMember(workspace.id, existing.id, 'employee');
    await prisma().workspaceMember.update({ where: { id: m.id }, data: { isActive: false } });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'rejoin@example.com', token: 'accept-rejoin', role: 'manager' });

    const res = await request(srv())
      .post('/api/v1/invitations/accept/accept-rejoin')
      .send({ password: 'Rejoin1!' });
    expect(res.status).toBe(201);
    const reactivated = await prisma().workspaceMember.findUnique({ where: { id: m.id } });
    expect(reactivated).toMatchObject({ isActive: true, role: 'manager' });
  });

  it('deactivated user account: 401', async () => {
    const { workspace, member } = await seedAdmin();
    const { user: existing } = await createUser({ email: 'deact@example.com', password: 'Deact123!' });
    await prisma().user.update({ where: { id: existing.id }, data: { isActive: false } });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'deact@example.com', token: 'accept-deact' });

    const res = await request(srv())
      .post('/api/v1/invitations/accept/accept-deact')
      .send({ password: 'Deact123!' });
    expect(res.status).toBe(401);
  });

  it('OAuth-only account (no password hash): token alone authorizes the join', async () => {
    const { workspace, member } = await seedAdmin();
    const oauthUser = await prisma().user.create({
      data: { email: 'oauth@example.com', name: 'OAuth User', authProvider: 'google', isActive: true, passwordHash: null },
    });
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'oauth@example.com', token: 'accept-oauth' });

    const res = await request(srv())
      .post('/api/v1/invitations/accept/accept-oauth')
      .send({ password: 'whateverpasses1!' });
    expect(res.status).toBe(201);
    const m = await prisma().workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: oauthUser.id } });
    expect(m!.isActive).toBe(true);
  });

  it('rejects passwords shorter than 8 chars with 400', async () => {
    const { workspace, member } = await seedAdmin();
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'short@example.com', token: 'accept-short' });
    const res = await request(srv())
      .post('/api/v1/invitations/accept/accept-short')
      .send({ password: 'short' });
    expect(res.status).toBe(400);
  });

  it('unknown / expired / accepted tokens: 404 / 400 / 400', async () => {
    const { workspace, member } = await seedAdmin();
    await request(srv()).post('/api/v1/invitations/accept/ghost').send({ password: 'GoodPass1!' }).expect(404);

    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'e1@example.com', token: 'exp1', expiresAt: new Date(Date.now() - 1000) });
    await request(srv()).post('/api/v1/invitations/accept/exp1').send({ password: 'GoodPass1!' }).expect(400);

    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'e2@example.com', token: 'acc1', acceptedAt: new Date() });
    await request(srv()).post('/api/v1/invitations/accept/acc1').send({ password: 'GoodPass1!' }).expect(400);
  });

  it('a token is single-use: the second accept returns 400', async () => {
    const { workspace, member } = await seedAdmin();
    await seedInvitation({ workspaceId: workspace.id, invitedBy: member.id, email: 'once@example.com', name: 'Once', token: 'accept-once' });

    await request(srv()).post('/api/v1/invitations/accept/accept-once').send({ password: 'FirstTime1!' }).expect(201);
    await request(srv()).post('/api/v1/invitations/accept/accept-once').send({ password: 'FirstTime1!' }).expect(400);
  });
});
