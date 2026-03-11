import { Injectable, Module, Controller, Get, Patch, Post, Param, Query, UseGuards } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard } from '@/common/guards';
import { successResponse, PaginationDto, paginationMeta } from '@/common/dto/response.dto';
@Injectable() export class NotificationsService {
  constructor(private prisma: PrismaService) {}
  async findAll(wid: string, rid: string, p: PaginationDto) { const [n, t] = await Promise.all([this.prisma.notification.findMany({ where: { workspaceId: wid, recipientId: rid }, skip: (p.page-1)*p.perPage, take: p.perPage, orderBy: { createdAt: 'desc' } }), this.prisma.notification.count({ where: { workspaceId: wid, recipientId: rid } })]); return { notifications: n, meta: paginationMeta(t, p.page, p.perPage) }; }
  async unreadCount(wid: string, rid: string) { return this.prisma.notification.count({ where: { workspaceId: wid, recipientId: rid, isRead: false } }); }
  async markRead(nid: string) { return this.prisma.notification.update({ where: { id: nid }, data: { isRead: true, readAt: new Date() } }); }
  async markAllRead(wid: string, rid: string) { return this.prisma.notification.updateMany({ where: { workspaceId: wid, recipientId: rid, isRead: false }, data: { isRead: true, readAt: new Date() } }); }
  async create(wid: string, rid: string, type: string, title: string, body: string, data = {}) { return this.prisma.notification.create({ data: { workspaceId: wid, recipientId: rid, type, title, body, data } }); }
}
@WebSocketGateway({ namespace: '/ws', cors: { origin: '*', credentials: true } }) export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  handleConnection(c: Socket) { const mid = c.handshake.query.memberId as string; if (mid) c.join('member:'+mid); }
  handleDisconnect() {}
  sendToMember(mid: string, event: string, data: unknown) { this.server.to('member:'+mid).emit(event, data); }
  sendToWorkspace(wid: string, event: string, data: unknown) { this.server.to('workspace:'+wid).emit(event, data); }
}
@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard) export class NotificationsController {
  constructor(private svc: NotificationsService) {}
  @Get('notifications') async all(@Param('wid') w: string, @CurrentMember() m: CurrentWorkspaceMember, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p); return successResponse(r.notifications, r.meta); }
  @Get('notifications/unread-count') async unread(@Param('wid') w: string, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse({ count: await this.svc.unreadCount(w, m.id) }); }
  @Patch('notifications/:nid/read') async read(@Param('nid') n: string) { return successResponse(await this.svc.markRead(n)); }
  @Post('notifications/read-all') async readAll(@Param('wid') w: string, @CurrentMember() m: CurrentWorkspaceMember) { await this.svc.markAllRead(w, m.id); return successResponse({ ok: true }); }
}
@Module({ controllers: [NotificationsController], providers: [NotificationsService, NotificationsGateway], exports: [NotificationsService, NotificationsGateway] }) export class NotificationsModule {}
