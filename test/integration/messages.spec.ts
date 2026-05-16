import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember, createWorkspace } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

// Helpers ─────────────────────────────────────────────────────────────────────

/** Sets up admin + N peers in a single workspace. Returns admin {user,member} +
 *  peers as an array of {user,member}. */
async function setupWorkspaceWithPeers(peerCount = 1) {
  const seed = await seedWorkspace();
  const peers: { user: any; member: any }[] = [];
  for (let i = 0; i < peerCount; i++) {
    const { user } = await createUser();
    const member = await addMember(seed.workspace.id, user.id, 'employee');
    peers.push({ user, member });
  }
  return { ...seed, peers };
}

describe('Messages — DM creation + idempotency', () => {
  it('POST /conversations/with/:memberId creates a 1:1 conversation (name=null, 2 members)', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const peer = peers[0];

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/with/${peer.member.id}`)
      .set(authHeader(admin.id, admin.email));

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ name: null, isGroup: false, memberCount: 2 });
    expect(res.body.data.id).toBeTruthy();

    const conv = await prisma().conversation.findUnique({
      where: { id: res.body.data.id },
      include: { members: true },
    });
    expect(conv).not.toBeNull();
    expect(conv!.name).toBeNull();
    expect(conv!.members).toHaveLength(2);
    const memberIds = conv!.members.map((m: any) => m.workspaceMemberId).sort();
    expect(memberIds).toEqual([peer.member.id, (await seedAdminMemberId(workspace.id, admin.id))].sort());
  });

  it('second POST with the same peer reuses the existing DM (idempotent)', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const peer = peers[0];

    const first = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/with/${peer.member.id}`)
      .set(authHeader(admin.id, admin.email));
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/with/${peer.member.id}`)
      .set(authHeader(admin.id, admin.email));
    expect(second.status).toBe(201);

    expect(second.body.data.id).toBe(first.body.data.id);

    const all = await prisma().conversation.findMany({ where: { workspaceId: workspace.id, name: null } });
    expect(all).toHaveLength(1);
  });

  it('DM with self returns 4xx', async () => {
    const { user: admin, workspace, member: adminMember } = await seedWorkspace();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/with/${adminMember.id}`)
      .set(authHeader(admin.id, admin.email));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
  });

  it('DM with a member from a different workspace returns 4xx/404', async () => {
    const { user: admin, workspace } = await seedWorkspace();
    // Create a totally separate workspace + member; admin is NOT in that workspace.
    const { user: other } = await createUser();
    const otherWs = await createWorkspace({ ownerUserId: other.id });
    // The target member belongs to otherWs, not `workspace`.
    const otherMember = otherWs.member;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/with/${otherMember.id}`)
      .set(authHeader(admin.id, admin.email));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
  });
});

describe('Messages — Group creation', () => {
  it('POST /conversations/group creates a group with name + members', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(2);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/group`)
      .set(authHeader(admin.id, admin.email))
      .send({ name: 'Project Group', memberIds: [peers[0].member.id, peers[1].member.id] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ name: 'Project Group', isGroup: true, memberCount: 3 });

    const conv = await prisma().conversation.findUnique({
      where: { id: res.body.data.id },
      include: { members: true },
    });
    expect(conv).not.toBeNull();
    expect(conv!.name).toBe('Project Group');
    expect(conv!.members).toHaveLength(3);
  });

  it('group requires at least 3 members total (caller + 2 others)', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    // Only 1 other member supplied → ids = {admin, peer} = 2 < 3 → BadRequest
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/group`)
      .set(authHeader(admin.id, admin.email))
      .send({ name: 'Tiny', memberIds: [peers[0].member.id] });
    // class-validator's @ArrayMinSize(2) trips first, returning 400.
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('dedupes groups created within 60s — second POST with identical name + members returns the same conversation', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(2);
    const payload = { name: 'Dup Group', memberIds: [peers[0].member.id, peers[1].member.id] };

    const first = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/group`)
      .set(authHeader(admin.id, admin.email))
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/group`)
      .set(authHeader(admin.id, admin.email))
      .send(payload);
    expect(second.status).toBe(201);

    expect(second.body.data.id).toBe(first.body.data.id);
    const groups = await prisma().conversation.findMany({ where: { workspaceId: workspace.id, name: 'Dup Group' } });
    expect(groups).toHaveLength(1);
  });
});

describe('Messages — Send / list / edit / delete', () => {
  it('POST /:cid/messages creates a message visible via GET', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);

    const send = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages`)
      .set(authHeader(admin.id, admin.email))
      .send({ body: 'hello world' });
    expect(send.status).toBe(201);
    expect(send.body.data).toMatchObject({ body: 'hello world', conversationId: cid });

    const get = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages`)
      .set(authHeader(admin.id, admin.email));
    expect(get.status).toBe(200);
    expect(get.body.data).toHaveLength(1);
    expect(get.body.data[0].body).toBe('hello world');
    expect(get.body.meta).toMatchObject({ total: 1, page: 1 });
  });

  it('GET /:cid/messages returns the page in oldest-first order (controller reverses)', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);

    // Insert three messages with deterministic timestamps so ordering is stable.
    const adminMemberId = await seedAdminMemberId(workspace.id, admin.id);
    const t = Date.now();
    await prisma().message.create({ data: { conversationId: cid, senderId: adminMemberId, body: 'first',  createdAt: new Date(t),       kind: 'text' } });
    await prisma().message.create({ data: { conversationId: cid, senderId: adminMemberId, body: 'second', createdAt: new Date(t + 10), kind: 'text' } });
    await prisma().message.create({ data: { conversationId: cid, senderId: adminMemberId, body: 'third',  createdAt: new Date(t + 20), kind: 'text' } });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages`)
      .set(authHeader(admin.id, admin.email));
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: any) => m.body)).toEqual(['first', 'second', 'third']);
  });

  it('PATCH /:cid/messages/:mid edits the body — only author may edit', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const peer = peers[0];
    const cid = await createDm(admin, workspace.id, peer.member.id);

    const sent = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages`)
      .set(authHeader(admin.id, admin.email))
      .send({ body: 'original' });
    expect(sent.status).toBe(201);
    const mid = sent.body.data.id;

    // Author can edit.
    const ok = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}`)
      .set(authHeader(admin.id, admin.email))
      .send({ body: 'edited' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.body).toBe('edited');
    expect(ok.body.data.editedAt).toBeTruthy();

    // Non-author (peer is a participant of the DM but not the sender) cannot edit.
    const denied = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}`)
      .set(authHeader(peer.user.id, peer.user.email))
      .send({ body: 'hijacked' });
    expect(denied.status).toBe(403);

    // DB confirms the body is still "edited", not "hijacked".
    const row = await prisma().message.findUnique({ where: { id: mid } });
    expect(row!.body).toBe('edited');
  });

  it('DELETE /:cid/messages/:mid soft-deletes (sets deletedAt, blanks body)', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);

    const sent = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages`)
      .set(authHeader(admin.id, admin.email))
      .send({ body: 'will be deleted' });
    const mid = sent.body.data.id;

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}`)
      .set(authHeader(admin.id, admin.email));
    expect(del.status).toBe(200);

    const row = await prisma().message.findUnique({ where: { id: mid } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.body).toBe('');
  });

  it('non-member cannot POST to a conversation (403)', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);

    // Add a third workspace member who is NOT in this DM.
    const { user: outsider } = await createUser();
    await addMember(workspace.id, outsider.id, 'employee');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages`)
      .set(authHeader(outsider.id, outsider.email))
      .send({ body: 'sneaky' });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

describe('Messages — Reactions', () => {
  it('POST /:cid/messages/:mid/reactions creates a reaction row', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);
    const mid = await sendMessage(admin, workspace.id, cid, 'react to me');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}/reactions`)
      .set(authHeader(admin.id, admin.email))
      .send({ emoji: ':+1:' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reactions.length).toBe(1);
    expect(res.body.data.reactions[0].emoji).toBe(':+1:');

    const rows = await prisma().messageReaction.findMany({ where: { messageId: mid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe(':+1:');
  });

  it('DELETE /:cid/messages/:mid/reactions/:emoji removes own reaction', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);
    const mid = await sendMessage(admin, workspace.id, cid, 'react then unreact');

    // Add reaction.
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}/reactions`)
      .set(authHeader(admin.id, admin.email))
      .send({ emoji: ':+1:' });

    const emoji = encodeURIComponent(':+1:');
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}/reactions/${emoji}`)
      .set(authHeader(admin.id, admin.email));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = await prisma().messageReaction.findMany({ where: { messageId: mid } });
    expect(rows).toHaveLength(0);
  });
});

describe('Messages — Pin / Forward / Mute', () => {
  it('POST /:cid/messages/:mid/pin toggles isPinned', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);
    const mid = await sendMessage(admin, workspace.id, cid, 'pin me');

    // First call → pinned=true.
    const r1 = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}/pin`)
      .set(authHeader(admin.id, admin.email));
    expect(r1.status).toBe(201);
    expect(r1.body.data.isPinned).toBe(true);
    let row = await prisma().message.findUnique({ where: { id: mid } });
    expect(row!.isPinned).toBe(true);

    // Second call → toggles off.
    const r2 = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/messages/${mid}/pin`)
      .set(authHeader(admin.id, admin.email));
    expect(r2.status).toBe(201);
    expect(r2.body.data.isPinned).toBe(false);
    row = await prisma().message.findUnique({ where: { id: mid } });
    expect(row!.isPinned).toBe(false);
  });

  it('POST /:cid/messages/:mid/forward creates a new message in the target with forwardedFromId set', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(2);
    const srcCid = await createDm(admin, workspace.id, peers[0].member.id);
    const dstCid = await createDm(admin, workspace.id, peers[1].member.id);
    const srcMid = await sendMessage(admin, workspace.id, srcCid, 'forward this');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${srcCid}/messages/${srcMid}/forward`)
      .set(authHeader(admin.id, admin.email))
      .send({ toConversationId: dstCid, comment: 'fyi' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ conversationId: dstCid, body: 'fyi' });
    expect(res.body.data.forwardedFromId).toBe(srcMid);

    const dstMessages = await prisma().message.findMany({ where: { conversationId: dstCid } });
    expect(dstMessages).toHaveLength(1);
    expect(dstMessages[0].forwardedFromId).toBe(srcMid);
    expect(dstMessages[0].body).toBe('fyi');
  });

  it('POST /:cid/mute sets mutedUntil on the caller\'s ConversationMember row', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);
    const adminMemberId = await seedAdminMemberId(workspace.id, admin.id);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/mute`)
      .set(authHeader(admin.id, admin.email))
      .send({ mutedUntil: future });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.mutedUntil).toBeTruthy();

    const row = await prisma().conversationMember.findUnique({
      where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: adminMemberId } },
    });
    expect(row!.mutedUntil).not.toBeNull();
    // Peer's mute should still be null — only the caller is muted.
    const peerRow = await prisma().conversationMember.findUnique({
      where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: peers[0].member.id } },
    });
    expect(peerRow!.mutedUntil).toBeNull();
  });
});

describe('Messages — Search', () => {
  it('GET /:cid/search?q=keyword returns case-insensitive matching messages', async () => {
    const { user: admin, workspace, peers } = await setupWorkspaceWithPeers(1);
    const cid = await createDm(admin, workspace.id, peers[0].member.id);

    await sendMessage(admin, workspace.id, cid, 'apples and oranges');
    await sendMessage(admin, workspace.id, cid, 'just bananas');
    await sendMessage(admin, workspace.id, cid, 'APPLE pie recipe');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/conversations/${cid}/search`)
      .query({ q: 'apple' })
      .set(authHeader(admin.id, admin.email));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    const bodies = res.body.data.map((m: any) => m.body).sort();
    expect(bodies).toEqual(['APPLE pie recipe', 'apples and oranges'].sort());
    expect(res.body.meta.total).toBe(2);
  });
});

// Test helpers ────────────────────────────────────────────────────────────────

async function seedAdminMemberId(workspaceId: string, userId: string): Promise<string> {
  const m = await prisma().workspaceMember.findFirst({ where: { workspaceId, userId } });
  return m!.id;
}

async function createDm(admin: { id: string; email: string }, workspaceId: string, peerMemberId: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/workspaces/${workspaceId}/conversations/with/${peerMemberId}`)
    .set(authHeader(admin.id, admin.email));
  if (res.status !== 201) throw new Error(`createDm failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}

async function sendMessage(admin: { id: string; email: string }, workspaceId: string, cid: string, body: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/workspaces/${workspaceId}/conversations/${cid}/messages`)
    .set(authHeader(admin.id, admin.email))
    .send({ body });
  if (res.status !== 201) throw new Error(`sendMessage failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}
