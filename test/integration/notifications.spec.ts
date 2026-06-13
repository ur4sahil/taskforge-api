import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createUser, addMember } from '../fixtures/factories';
import { authHeader } from '../fixtures/auth';
import { NotificationsService } from '../../src/modules/notifications/notifications.module';

let app: INestApplication;
let svc: NotificationsService;
beforeAll(async () => { app = await bootstrapApp(); svc = app.get(NotificationsService); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();

async function seedNotification(workspaceId: string, recipientId: string, overrides: any = {}) {
  return prisma().notification.create({
    data: { workspaceId, recipientId, type: 'mention', title: 'T', body: 'B', ...overrides },
  });
}

describe('Notifications — feed', () => {
  it('returns the members own notifications, newest first, with pagination meta', async () => {
    const { user, workspace, member } = await seedWorkspace();
    await seedNotification(workspace.id, member.id, { title: 'older', createdAt: new Date(Date.now() - 10000) });
    await seedNotification(workspace.id, member.id, { title: 'newer', createdAt: new Date() });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/notifications?page=1&perPage=10`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].title).toBe('newer');
    expect(res.body.meta).toMatchObject({ total: 2, page: 1, perPage: 10 });
  });

  it('does not return another members notifications', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const { user: other } = await createUser();
    const otherMember = await addMember(workspace.id, other.id, 'employee');
    await seedNotification(workspace.id, otherMember.id, { title: 'theirs' });
    await seedNotification(workspace.id, member.id, { title: 'mine' });

    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/notifications`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('mine');
  });

  it('unread-count counts only unread notifications', async () => {
    const { user, workspace, member } = await seedWorkspace();
    await seedNotification(workspace.id, member.id, { isRead: false });
    await seedNotification(workspace.id, member.id, { isRead: false });
    await seedNotification(workspace.id, member.id, { isRead: true });
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/notifications/unread-count`)
      .set(authHeader(user.id, user.email));
    expect(res.body.data).toEqual({ count: 2 });
  });

  it('marks a single notification read (sets readAt)', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const n = await seedNotification(workspace.id, member.id, { isRead: false });
    const res = await request(srv())
      .patch(`/api/v1/workspaces/${workspace.id}/notifications/${n.id}/read`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
    expect(res.body.data.readAt).not.toBeNull();
  });

  it('read-all marks every unread notification read', async () => {
    const { user, workspace, member } = await seedWorkspace();
    await seedNotification(workspace.id, member.id, { isRead: false });
    await seedNotification(workspace.id, member.id, { isRead: false });
    const res = await request(srv())
      .post(`/api/v1/workspaces/${workspace.id}/notifications/read-all`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(201);
    expect(await prisma().notification.count({ where: { recipientId: member.id, isRead: false } })).toBe(0);
  });

  it('rejects unauthenticated access with 401', async () => {
    const { workspace } = await seedWorkspace();
    await request(srv()).get(`/api/v1/workspaces/${workspace.id}/notifications`).expect(401);
  });
});

describe('Notifications — prefs', () => {
  it('returns merged defaults when the member has no stored prefs', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/notifications/prefs`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ pushEnabled: expect.any(Boolean), inAppEnabled: expect.any(Boolean) });
    expect(res.body.data.channels).toBeDefined();
    expect(res.body.data.quietHours).toBeDefined();
  });

  it('applies a partial prefs patch and persists it', async () => {
    const { user, workspace, member } = await seedWorkspace();
    const res = await request(srv())
      .patch(`/api/v1/workspaces/${workspace.id}/notifications/prefs`)
      .set(authHeader(user.id, user.email))
      .send({ pushEnabled: false, channels: { mention: false } });
    expect(res.status).toBe(200);
    expect(res.body.data.pushEnabled).toBe(false);
    expect(res.body.data.channels.mention).toBe(false);

    const stored = await prisma().workspaceMember.findUnique({ where: { id: member.id }, select: { notificationPreferences: true } });
    expect((stored!.notificationPreferences as any).pushEnabled).toBe(false);
  });

  it('exposes the prefs defaults', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(srv())
      .get(`/api/v1/workspaces/${workspace.id}/notifications/defaults`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('Notifications — dispatch funnel', () => {
  it('writes an in-app row and returns it for an active member with default prefs', async () => {
    const { workspace, member } = await seedWorkspace();
    const row = await svc.dispatch({
      workspaceId: workspace.id, recipientMemberId: member.id,
      channel: 'mention', type: 'mention', title: 'Hi', body: 'You were mentioned',
    });
    expect(row).not.toBeNull();
    expect(await prisma().notification.count({ where: { recipientId: member.id } })).toBe(1);
  });

  it('returns null and writes nothing when the recipient id is empty', async () => {
    const { workspace } = await seedWorkspace();
    const row = await svc.dispatch({
      workspaceId: workspace.id, recipientMemberId: '',
      channel: 'mention', type: 'mention', title: 'x', body: 'y',
    });
    expect(row).toBeNull();
    expect(await prisma().notification.count()).toBe(0);
  });

  it('returns null for a deactivated member', async () => {
    const { workspace, member } = await seedWorkspace();
    await prisma().workspaceMember.update({ where: { id: member.id }, data: { isActive: false } });
    const row = await svc.dispatch({
      workspaceId: workspace.id, recipientMemberId: member.id,
      channel: 'mention', type: 'mention', title: 'x', body: 'y',
    });
    expect(row).toBeNull();
    expect(await prisma().notification.count()).toBe(0);
  });

  it('skips the in-app row when in-app is disabled, but still returns null (non-high-priority)', async () => {
    const { workspace, member } = await seedWorkspace();
    await svc.updatePrefs(member.id, { inAppEnabled: false, pushEnabled: false });
    const row = await svc.dispatch({
      workspaceId: workspace.id, recipientMemberId: member.id,
      channel: 'mention', type: 'mention', title: 'x', body: 'y',
    });
    expect(row).toBeNull();
    expect(await prisma().notification.count({ where: { recipientId: member.id } })).toBe(0);
  });

  it('high-priority always writes an in-app row even with in-app disabled', async () => {
    const { workspace, member } = await seedWorkspace();
    await svc.updatePrefs(member.id, { inAppEnabled: false, pushEnabled: false });
    const row = await svc.dispatch({
      workspaceId: workspace.id, recipientMemberId: member.id,
      channel: 'call', type: 'call_invite', title: 'Incoming call', body: '...', highPriority: true,
    });
    expect(row).not.toBeNull();
    expect(await prisma().notification.count({ where: { recipientId: member.id } })).toBe(1);
  });

  it('dispatchMany fans out to recipients and skips the sender', async () => {
    const { workspace, member } = await seedWorkspace();
    const { user: u2 } = await createUser();
    const m2 = await addMember(workspace.id, u2.id, 'employee');
    await svc.dispatchMany([member.id, m2.id, member.id], member.id, {
      workspaceId: workspace.id, channel: 'mention', type: 'mention', title: 'x', body: 'y',
    });
    expect(await prisma().notification.count({ where: { recipientId: member.id } })).toBe(0); // sender skipped
    expect(await prisma().notification.count({ where: { recipientId: m2.id } })).toBe(1);
  });
});
