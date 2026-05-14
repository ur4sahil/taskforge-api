import { Injectable, Module, Controller, Get, Patch, Post, Body, Param, Query, UseGuards, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { PushModule, PushService } from '../push/push.module';
import { PresenceModule, PresenceService } from '../presence/presence.module';
import { mergePrefs, isQuietNow, NotificationPrefs, NotificationChannel, PREFS_DEFAULTS } from '../../common/notification-prefs';

export interface DispatchPayload {
  workspaceId: string;
  recipientMemberId: string;
  channel: NotificationChannel;
  type: string;                  // free-form notification.type (mention, task_assigned, call_invite, ...)
  title: string;
  body: string;
  url?: string;                  // deep link the SW / toast should navigate to on click
  entityType?: string;           // task / comment / message / call etc
  entityId?: string;
  /** If the recipient is currently focused on this screen, skip the push (in-app still arrives). */
  suppressIfActiveScreen?: string;
  /** Tag for push grouping/replace (e.g. `msg:<convId>` so successive msgs replace each other). */
  pushTag?: string;
  /** When true, bypasses quietHours + suppressIfActiveScreen + pushEnabled and always fires push.
   *  Reserved for incoming calls — the user MUST be interrupted. */
  highPriority?: boolean;
  /** When true, push is shown with action buttons (Answer / Decline) and requires interaction.
   *  Only meaningful for incoming-call pushes. */
  callInvite?: { conversationId: string; fromMemberId: string };
}

@Injectable()
export class NotificationsService {
  private log = new Logger('Notifications');
  constructor(
    private prisma: PrismaService,
    private push: PushService,
    private presence: PresenceService,
  ) {}

  // ── CRUD endpoints (in-app notification feed) ────────────────────────────
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

  // ── Prefs ────────────────────────────────────────────────────────────────
  async getPrefs(memberId: string): Promise<NotificationPrefs> {
    const m = await this.prisma.workspaceMember.findUnique({ where: { id: memberId }, select: { notificationPreferences: true } });
    return mergePrefs(m?.notificationPreferences);
  }
  async updatePrefs(memberId: string, patch: Partial<NotificationPrefs>) {
    const current = await this.getPrefs(memberId);
    const next: NotificationPrefs = {
      pushEnabled: patch.pushEnabled ?? current.pushEnabled,
      inAppEnabled: patch.inAppEnabled ?? current.inAppEnabled,
      channels: { ...current.channels, ...(patch.channels || {}) },
      quietHours: { ...current.quietHours, ...(patch.quietHours || {}) },
    };
    await this.prisma.workspaceMember.update({ where: { id: memberId }, data: { notificationPreferences: next as any } });
    return next;
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  /** Single funnel for every "user X should be notified about Y" event. Handles:
   *   1. preference + quiet-hours gating
   *   2. active-screen suppression (don't push to a tab that's literally looking at the thing)
   *   3. Notification row insert
   *   4. socket 'notification:new' emit
   *   5. web push send (only if not online-and-focused; calls bypass)
   *
   *  Returns the created Notification row or null when fully suppressed (incl. self-skip). */
  async dispatch(p: DispatchPayload) {
    try {
      // No self-notifications.
      if (!p.recipientMemberId) return null;

      const member = await this.prisma.workspaceMember.findUnique({
        where: { id: p.recipientMemberId },
        select: { id: true, timezone: true, notificationPreferences: true, isActive: true },
      });
      if (!member || !member.isActive) return null;

      const prefs = mergePrefs(member.notificationPreferences);
      const channelOn = prefs.channels[p.channel] !== false;

      // In-app row: write unless user explicitly turned off in-app AND it's not a call.
      // Calls always log to feed so the user has a record after.
      const writeInApp = (prefs.inAppEnabled && channelOn) || p.highPriority;
      let row: any = null;
      if (writeInApp) {
        row = await this.prisma.notification.create({
          data: {
            workspaceId: p.workspaceId,
            recipientId: p.recipientMemberId,
            type: p.type,
            title: p.title,
            body: p.body,
            data: {
              url: p.url,
              channel: p.channel,
              entityType: p.entityType,
              entityId: p.entityId,
            },
          },
        });
        // Live in-app event (toast + bell badge).
        this.presence.emitToMember(p.recipientMemberId, 'notification:new', row);
      }

      // Push decision tree.
      const screenSuppressed = p.suppressIfActiveScreen && this.presence.isActiveOn(p.recipientMemberId, p.suppressIfActiveScreen);
      const quiet = isQuietNow(prefs, member.timezone || 'UTC');
      const allowPush = p.highPriority
        ? true
        : (prefs.pushEnabled && channelOn && !screenSuppressed && !quiet);

      if (!allowPush) return row;

      const url = p.url || '/';
      const pushPayload: any = {
        title: p.title,
        body: p.body,
        url,
        tag: p.pushTag,
        data: {
          url,
          type: p.type,
          channel: p.channel,
          entityType: p.entityType,
          entityId: p.entityId,
          notificationId: row?.id,
        },
      };
      if (p.callInvite) {
        pushPayload.data.call = p.callInvite;
        pushPayload.data.action = 'call-invite';
        pushPayload.requireInteraction = true;
      }
      // Fire and forget. PushService prunes 410/404 itself.
      this.push.sendToMember(p.recipientMemberId, pushPayload, p.highPriority ? 'high' : 'normal').catch(err => {
        this.log.warn(`push send failed for ${p.recipientMemberId}: ${err?.message || err}`);
      });

      return row;
    } catch (err: any) {
      this.log.error(`dispatch failed: ${err?.message || err}`);
      return null;
    }
  }

  /** Convenience: dispatch the same event to multiple recipients (skipping a sender). */
  async dispatchMany(memberIds: string[], skipMemberId: string | null, base: Omit<DispatchPayload, 'recipientMemberId'>) {
    const recipients = Array.from(new Set(memberIds)).filter(id => id && id !== skipMemberId);
    await Promise.all(recipients.map(id => this.dispatch({ ...base, recipientMemberId: id })));
  }
}

@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard)
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  @Get('notifications') async all(@Param('wid') w: string, @CurrentMember() m: any, @Query() p: PaginationDto) {
    const r = await this.svc.findAll(w, m.id, p.page, p.perPage);
    return successResponse(r.notifications, r.meta);
  }
  @Get('notifications/unread-count') async unread(@Param('wid') w: string, @CurrentMember() m: any) { return successResponse({ count: await this.svc.unreadCount(w, m.id) }); }
  @Patch('notifications/:nid/read') async read(@Param('nid') n: string) { return successResponse(await this.svc.markRead(n)); }
  @Post('notifications/read-all') async readAll(@Param('wid') w: string, @CurrentMember() m: any) { await this.svc.markAllRead(w, m.id); return successResponse({ ok: true }); }

  @Get('notifications/prefs') async getPrefs(@CurrentMember() m: any) {
    return successResponse(await this.svc.getPrefs(m.id));
  }
  @Patch('notifications/prefs') async updatePrefs(@CurrentMember() m: any, @Body() patch: any) {
    return successResponse(await this.svc.updatePrefs(m.id, patch));
  }
  @Get('notifications/defaults') async defaults() { return successResponse(PREFS_DEFAULTS); }
}

@Module({
  imports: [PushModule, PresenceModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
