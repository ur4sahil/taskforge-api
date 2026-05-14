import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect, MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule, MessagesService } from '../messages/messages.module';

/** Connection state we hang off the socket so per-event handlers don't re-decode JWT. */
interface AuthedSocket extends Socket {
  data: {
    userId?: string;
    workspaceId?: string;
    workspaceMemberId?: string;
  };
}

/** Validate the JWT presented at connection time and load the caller's WorkspaceMember row.
 *  The client passes both the access token AND the workspace id at handshake:
 *    io(`${apiUrl}/chat`, { auth: { token, workspaceId } })
 *  Either rejection here disconnects the socket before any event is handled. */
async function authenticate(socket: Socket, jwt: JwtService, config: ConfigService, prisma: PrismaService) {
  const log = new Logger('Realtime');
  const token = (socket.handshake.auth as any)?.token || socket.handshake.query?.token;
  const workspaceId = (socket.handshake.auth as any)?.workspaceId || socket.handshake.query?.workspaceId;
  if (!token || !workspaceId) { socket.disconnect(true); log.warn(`Reject: missing token/workspaceId from ${socket.id}`); return null; }
  let payload: any;
  try {
    payload = jwt.verify(token as string, { secret: config.get('auth.jwtAccessSecret') });
  } catch {
    socket.disconnect(true); log.warn(`Reject: bad JWT from ${socket.id}`); return null;
  }
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId: workspaceId as string, userId: payload.sub, isActive: true },
  });
  if (!member) { socket.disconnect(true); log.warn(`Reject: not a workspace member (${payload.sub} in ${workspaceId})`); return null; }
  return { userId: payload.sub as string, workspaceId: workspaceId as string, workspaceMemberId: member.id };
}

@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: process.env.APP_URL || 'http://localhost:3000', credentials: true },
})
@Injectable()
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private log = new Logger('ChatGateway');

  // Multi-tab presence: count active sockets per member. Member is online iff size > 0.
  // Map<memberId, Set<socketId>>; keyed by workspaceId for fast workspace-scoped lookups.
  private presence = new Map<string, Map<string, Set<string>>>();

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
    private messages: MessagesService,
  ) {}

  async handleConnection(socket: AuthedSocket) {
    const auth = await authenticate(socket, this.jwt, this.config, this.prisma);
    if (!auth) return;
    socket.data = auth;
    const memberships = await this.prisma.conversationMember.findMany({
      where: { workspaceMemberId: auth.workspaceMemberId, conversation: { workspaceId: auth.workspaceId } },
      select: { conversationId: true },
    });
    for (const m of memberships) socket.join(this.roomFor(m.conversationId));
    socket.join(this.presenceRoomFor(auth.workspaceId));

    // Register this socket in the multi-tab presence map.
    const wsMap = this.presence.get(auth.workspaceId) || new Map<string, Set<string>>();
    if (!this.presence.has(auth.workspaceId)) this.presence.set(auth.workspaceId, wsMap);
    const wasOffline = !wsMap.has(auth.workspaceMemberId) || wsMap.get(auth.workspaceMemberId)!.size === 0;
    if (!wsMap.has(auth.workspaceMemberId)) wsMap.set(auth.workspaceMemberId, new Set());
    wsMap.get(auth.workspaceMemberId)!.add(socket.id);
    if (wasOffline) {
      this.server.to(this.presenceRoomFor(auth.workspaceId)).emit('presence:update', {
        memberId: auth.workspaceMemberId, online: true, at: new Date().toISOString(),
      });
    }
    // Push the full snapshot to the newly-connected socket so it can paint dots immediately.
    socket.emit('presence:snapshot', { online: Array.from(wsMap.keys()).filter(id => wsMap.get(id)!.size > 0) });
    this.log.log(`Connected ${auth.workspaceMemberId} (sock=${socket.id}, rooms=${memberships.length})`);
  }

  async handleDisconnect(socket: AuthedSocket) {
    if (!socket.data?.workspaceMemberId || !socket.data?.workspaceId) return;
    const wsMap = this.presence.get(socket.data.workspaceId);
    if (!wsMap) return;
    const set = wsMap.get(socket.data.workspaceMemberId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      wsMap.delete(socket.data.workspaceMemberId);
      this.server.to(this.presenceRoomFor(socket.data.workspaceId)).emit('presence:update', {
        memberId: socket.data.workspaceMemberId, online: false, at: new Date().toISOString(),
      });
    }
  }

  /** Client can request current snapshot any time (e.g. after reconnecting). */
  @SubscribeMessage('presence:request')
  onPresenceRequest(@ConnectedSocket() socket: AuthedSocket) {
    if (!socket.data.workspaceId) return;
    const wsMap = this.presence.get(socket.data.workspaceId);
    socket.emit('presence:snapshot', { online: wsMap ? Array.from(wsMap.keys()).filter(id => wsMap.get(id)!.size > 0) : [] });
  }

  /** Mark-read via socket. Broadcasts to the conv room so other participants see read receipts move. */
  @SubscribeMessage('message:read')
  async onMarkRead(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string }) {
    if (!socket.data.workspaceMemberId || !socket.data.workspaceId) return;
    try {
      await this.messages.markRead(socket.data.workspaceId, body.conversationId, socket.data.workspaceMemberId);
      this.server.to(this.roomFor(body.conversationId)).emit('read:update', {
        conversationId: body.conversationId,
        memberId: socket.data.workspaceMemberId,
        lastReadAt: new Date().toISOString(),
      });
    } catch {}
  }

  /** Client says: "I joined conversation X" — used when a new conversation is created mid-session. */
  @SubscribeMessage('join')
  async onJoin(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string }) {
    if (!socket.data.workspaceMemberId) return;
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_workspaceMemberId: { conversationId: body.conversationId, workspaceMemberId: socket.data.workspaceMemberId } },
    });
    if (!member) return; // silent ignore; client shouldn't have requested
    socket.join(this.roomFor(body.conversationId));
  }

  @SubscribeMessage('leave')
  onLeave(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string }) {
    socket.leave(this.roomFor(body.conversationId));
  }

  // Generic relay helper so REST endpoints (edit/delete/react) can broadcast too.
  emitMessageUpdate(cid: string, msg: any) {
    this.server?.to(this.roomFor(cid)).emit('message:update', msg);
  }

  /** Send a message AND broadcast it. REST endpoint /messages also exists but socket-send avoids
   *  the latency of an HTTPS roundtrip when the client already has the socket open. */
  @SubscribeMessage('message:send')
  async onSend(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string; body: string; attachmentIds?: string[]; replyToId?: string }) {
    if (!socket.data.workspaceMemberId || !socket.data.workspaceId) return;
    try {
      const msg = await this.messages.sendMessage(
        socket.data.workspaceId,
        body.conversationId,
        socket.data.workspaceMemberId,
        { body: body.body || '', attachmentIds: body.attachmentIds, replyToId: body.replyToId },
      );
      this.server.to(this.roomFor(body.conversationId)).emit('message:new', msg);
      return { ok: true, id: msg!.id };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to send' };
    }
  }

  @SubscribeMessage('typing')
  onTyping(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string; isTyping: boolean }) {
    if (!socket.data.workspaceMemberId) return;
    // Relay to the room except sender.
    socket.to(this.roomFor(body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      memberId: socket.data.workspaceMemberId,
      isTyping: !!body.isTyping,
    });
  }

  private roomFor(cid: string) { return `conv:${cid}`; }
  private presenceRoomFor(wid: string) { return `ws:${wid}:presence`; }

  /** Public helper so other gateways (CallGateway) can push events into a conversation room. */
  emitToConversation(cid: string, event: string, payload: any) {
    this.server?.to(this.roomFor(cid)).emit(event, payload);
  }
}

@WebSocketGateway({
  namespace: '/call',
  cors: { origin: process.env.APP_URL || 'http://localhost:3000', credentials: true },
})
@Injectable()
export class CallGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private log = new Logger('CallGateway');

  // Active group call rooms: Map<conversationId, Set<workspaceMemberId>>. Mesh topology
  // — every member has a peer connection to every other member. Capped at MAX_PARTICIPANTS.
  private rooms = new Map<string, Set<string>>();
  private static readonly MAX_PARTICIPANTS = 6;

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
    private messages: MessagesService,
  ) {}

  async handleConnection(socket: AuthedSocket) {
    const auth = await authenticate(socket, this.jwt, this.config, this.prisma);
    if (!auth) return;
    socket.data = auth;
    socket.join(this.memberRoom(auth.workspaceMemberId));
  }

  async handleDisconnect(socket: AuthedSocket) {
    if (!socket.data?.workspaceMemberId) return;
    // Drop this member from any rooms they were in (best-effort — they could have multiple
    // sockets; we still treat any disconnect as a leave so other peers tear down the PC).
    for (const [cid, members] of this.rooms.entries()) {
      if (members.has(socket.data.workspaceMemberId)) {
        members.delete(socket.data.workspaceMemberId);
        if (members.size === 0) this.rooms.delete(cid);
        this.server.to(this.callRoom(cid)).emit('call:peer-leave', {
          conversationId: cid, memberId: socket.data.workspaceMemberId,
        });
      }
    }
  }

  /** Group call: caller (or any participant) joins the room. Returns the current roster so
   *  the newly-joined client can initiate a peer connection to each existing participant. */
  @SubscribeMessage('call:room-join')
  async onRoomJoin(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string }) {
    if (!socket.data.workspaceMemberId || !socket.data.workspaceId) return { ok: false };
    // Verify participant in the conversation.
    const cm = await this.prisma.conversationMember.findUnique({
      where: { conversationId_workspaceMemberId: { conversationId: body.conversationId, workspaceMemberId: socket.data.workspaceMemberId } },
    });
    if (!cm) return { ok: false, error: 'Not a participant' };

    const set = this.rooms.get(body.conversationId) || new Set<string>();
    if (!this.rooms.has(body.conversationId)) this.rooms.set(body.conversationId, set);
    if (set.size >= CallGateway.MAX_PARTICIPANTS && !set.has(socket.data.workspaceMemberId)) {
      return { ok: false, error: `Call is full (max ${CallGateway.MAX_PARTICIPANTS})` };
    }
    const existing = Array.from(set).filter(id => id !== socket.data.workspaceMemberId);
    set.add(socket.data.workspaceMemberId);
    socket.join(this.callRoom(body.conversationId));

    // Tell everyone else: a new peer joined.
    this.server.to(this.callRoom(body.conversationId)).emit('call:peer-join', {
      conversationId: body.conversationId,
      memberId: socket.data.workspaceMemberId,
    });
    // First joiner writes a call-start system message.
    if (set.size === 1) {
      await this.messages.sendMessage(
        socket.data.workspaceId, body.conversationId, socket.data.workspaceMemberId,
        { body: 'Call started' }, 'call-start',
      ).catch(() => {});
    }
    return { ok: true, peers: existing };
  }

  @SubscribeMessage('call:room-leave')
  async onRoomLeave(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string; durationSec?: number }) {
    if (!socket.data.workspaceMemberId || !socket.data.workspaceId) return;
    const set = this.rooms.get(body.conversationId);
    if (!set) return;
    set.delete(socket.data.workspaceMemberId);
    socket.leave(this.callRoom(body.conversationId));
    this.server.to(this.callRoom(body.conversationId)).emit('call:peer-leave', {
      conversationId: body.conversationId, memberId: socket.data.workspaceMemberId,
    });
    if (set.size === 0) {
      this.rooms.delete(body.conversationId);
      const note = body.durationSec ? `Call ended (${Math.floor(body.durationSec / 60)}m ${body.durationSec % 60}s)` : 'Call ended';
      await this.messages.sendMessage(
        socket.data.workspaceId, body.conversationId, socket.data.workspaceMemberId,
        { body: note }, 'call-end',
      ).catch(() => {});
    }
  }

  /** Caller starts the call. We notify the target's personal room.
   *  Also writes a `call-start` system message into the conversation so the chat thread has a record. */
  @SubscribeMessage('call:invite')
  async onInvite(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string; toMemberId: string }) {
    if (!socket.data.workspaceMemberId || !socket.data.workspaceId) return;
    // Verify both are in this conversation.
    const cnt = await this.prisma.conversationMember.count({
      where: { conversationId: body.conversationId, workspaceMemberId: { in: [socket.data.workspaceMemberId, body.toMemberId] } },
    });
    if (cnt < 2) return { ok: false, error: 'Not authorized for this conversation' };

    await this.messages.sendMessage(
      socket.data.workspaceId,
      body.conversationId,
      socket.data.workspaceMemberId,
      { body: 'Call started' },
      'call-start',
    );
    this.server.to(this.memberRoom(body.toMemberId)).emit('call:invite', {
      conversationId: body.conversationId,
      fromMemberId: socket.data.workspaceMemberId,
    });
    return { ok: true };
  }

  /** Recipient accepted. Relay back to the caller so they can begin createOffer. */
  @SubscribeMessage('call:accept')
  onAccept(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string; toMemberId: string }) {
    this.server.to(this.memberRoom(body.toMemberId)).emit('call:accept', {
      conversationId: body.conversationId,
      fromMemberId: socket.data.workspaceMemberId,
    });
  }

  @SubscribeMessage('call:decline')
  async onDecline(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string; toMemberId: string }) {
    this.server.to(this.memberRoom(body.toMemberId)).emit('call:decline', {
      conversationId: body.conversationId,
      fromMemberId: socket.data.workspaceMemberId,
    });
  }

  // --- WebRTC SDP / ICE relay. Server is dumb pipe; payloads are opaque. ---

  @SubscribeMessage('call:offer')
  onOffer(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { toMemberId: string; conversationId: string; sdp: any }) {
    this.server.to(this.memberRoom(body.toMemberId)).emit('call:offer', { ...body, fromMemberId: socket.data.workspaceMemberId });
  }

  @SubscribeMessage('call:answer')
  onAnswer(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { toMemberId: string; conversationId: string; sdp: any }) {
    this.server.to(this.memberRoom(body.toMemberId)).emit('call:answer', { ...body, fromMemberId: socket.data.workspaceMemberId });
  }

  @SubscribeMessage('call:ice')
  onIce(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { toMemberId: string; conversationId: string; candidate: any }) {
    this.server.to(this.memberRoom(body.toMemberId)).emit('call:ice', { ...body, fromMemberId: socket.data.workspaceMemberId });
  }

  @SubscribeMessage('call:hangup')
  async onHangup(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { toMemberId: string; conversationId: string; durationSec?: number }) {
    if (!socket.data.workspaceMemberId || !socket.data.workspaceId) return;
    this.server.to(this.memberRoom(body.toMemberId)).emit('call:hangup', { ...body, fromMemberId: socket.data.workspaceMemberId });
    const mins = body.durationSec ? Math.floor(body.durationSec / 60) : 0;
    const secs = body.durationSec ? body.durationSec % 60 : 0;
    const note = body.durationSec ? `Call ended (${mins}m ${secs}s)` : 'Call ended';
    try {
      await this.messages.sendMessage(
        socket.data.workspaceId,
        body.conversationId,
        socket.data.workspaceMemberId,
        { body: note },
        'call-end',
      );
    } catch { /* not a participant or conversation gone; ignore */ }
  }

  private memberRoom(mid: string) { return `mem:${mid}`; }
  private callRoom(cid: string) { return `call:${cid}`; }
}

@Module({
  imports: [AuthModule, MessagesModule],
  providers: [ChatGateway, CallGateway],
  exports: [ChatGateway, CallGateway],
})
export class RealtimeModule {}
