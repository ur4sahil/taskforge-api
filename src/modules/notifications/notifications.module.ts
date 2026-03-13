import { Injectable, Module, Controller, Get, Patch, Post, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}
  async findAll(wid: string, rid: string, page: number, perPage: number) {
    const [n, t] = await Promise.all([
      this.prisma.notification.findMany({ where: { workspaceId: wid, recipientId: rid }, skip: (page - 1) * perPage, take: perPage, orderBy: { createdAt: 'desc' } }),
      this.prisma.notification.count({ where: { workspaceId: wid, recipientId: rid } }),
    ]);
    return { notifications: n, meta: paginationMeta(t, page, perPage) };
  }
  async unreadCount(wid: string, rid: string) { return this.prisma.notification.count({ where: { workspaceId: wid, recipientId: rid, isRead: false } }); }
  async markRead(nid: string) { return this.prisma.notification.update({ where: { id: nid }, data: { isRead: true, readAt: new Date() } }); }
  async markAllRead(wid: string, rid: string) { return this.prisma.notification.updateMany({ where: { workspaceId: wid, recipientId: rid, isRead: false }, data: { isRead: true, readAt: new Date() } }); }
}

@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard)
export class NotificationsController {
  constructor(private svc: NotificationsService) {}
  @Get('notifications') async all(@Param('wid') w: string, @CurrentMember() m: any, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p.page, p.perPage); return successResponse(r.notifications, r.meta); }
  @Get('notifications/unread-count') async unread(@Param('wid') w: string, @CurrentMember() m: any) { return successResponse({ count: await this.svc.unreadCount(w, m.id) }); }
  @Patch('notifications/:nid/read') async read(@Param('nid') n: string) { return successResponse(await this.svc.markRead(n)); }
  @Post('notifications/read-all') async readAll(@Param('wid') w: string, @CurrentMember() m: any) { await this.svc.markAllRead(w, m.id); return successResponse({ ok: true }); }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
