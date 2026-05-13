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
    // Auto-join every conversation room the user belongs to so they receive new-message
    // events without having to open each thread first (drives the unread badge in the sidebar).
    const memberships = await this.prisma.conversationMember.findMany({
      where: { workspaceMemberId: auth.workspaceMemberId, conversation: { workspaceId: auth.workspaceId } },
      select: { conversationId: true },
    });
    for (const m of memberships) socket.join(this.roomFor(m.conversationId));
    socket.join(this.presenceRoomFor(auth.workspaceId));
    this.server.to(this.presenceRoomFor(auth.workspaceId)).emit('presence', { memberId: auth.workspaceMemberId, online: true });
    this.log.log(`Connected ${auth.workspaceMemberId} (${memberships.length} rooms)`);
  }

  async handleDisconnect(socket: AuthedSocket) {
    if (!socket.data?.workspaceMemberId) return;
    this.server.to(this.presenceRoomFor(socket.data.workspaceId!)).emit('presence', { memberId: socket.data.workspaceMemberId, online: false });
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

  /** Send a message AND broadcast it. REST endpoint /messages also exists but socket-send avoids
   *  the latency of a HTTPS roundtrip when the client already has the socket open. */
  @SubscribeMessage('message:send')
  async onSend(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: { conversationId: string; body: string }) {
    if (!socket.data.workspaceMemberId || !socket.data.workspaceId) return;
    try {
      const msg = await this.messages.sendMessage(
        socket.data.workspaceId,
        body.conversationId,
        socket.data.workspaceMemberId,
        { body: body.body || '' },
      );
      this.server.to(this.roomFor(body.conversationId)).emit('message:new', msg);
      return { ok: true, id: msg.id };
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
export class CallGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;
  private log = new Logger('CallGateway');

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
    // Personal room — addressable by member id, used so the invite from caller → server → callee
    // can target the specific person regardless of how many sockets they have open.
    socket.join(this.memberRoom(auth.workspaceMemberId));
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
}

@Module({
  imports: [AuthModule, MessagesModule],
  providers: [ChatGateway, CallGateway],
  exports: [ChatGateway, CallGateway],
})
export class RealtimeModule {}
