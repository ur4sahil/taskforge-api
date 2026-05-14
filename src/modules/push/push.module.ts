import { Injectable, Module, Controller, Post, Delete, Get, Body, Headers, Param, UseGuards, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsNotEmpty, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';

// ───── DTOs ──────────────────────────────────────────────────────────────────

class SubscriptionKeysDto {
  @IsString() @IsNotEmpty() p256dh: string = '';
  @IsString() @IsNotEmpty() auth: string = '';
}

export class PushSubscribeDto {
  @IsString() @IsNotEmpty() endpoint: string = '';
  @IsObject() @ValidateNested() @Type(() => SubscriptionKeysDto) keys: SubscriptionKeysDto = { p256dh: '', auth: '' };
}

export class PushUnsubscribeDto {
  @IsString() @IsNotEmpty() endpoint: string = '';
}

// ───── Service ───────────────────────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;        // deep link opened on click
  tag?: string;        // dedupe key — same tag replaces an earlier notification
  data?: any;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly log = new Logger('PushService');
  private configured = false;

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  onModuleInit() {
    const pub = this.config.get<string>('push.vapidPublic');
    const priv = this.config.get<string>('push.vapidPrivate');
    const sub = this.config.get<string>('push.vapidSubject');
    if (pub && priv && sub) {
      webpush.setVapidDetails(sub, pub, priv);
      this.configured = true;
      this.log.log('VAPID configured — web push enabled');
    } else {
      this.log.warn('VAPID keys missing — web push disabled');
    }
  }

  getPublicKey(): string { return this.config.get<string>('push.vapidPublic') || ''; }

  /** Store or refresh a push subscription. Idempotent on (endpoint). */
  async subscribe(memberId: string, sub: PushSubscribeDto, userAgent?: string) {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        workspaceMemberId: memberId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        authKey: sub.keys.auth,
        userAgent: userAgent?.slice(0, 500) ?? null,
      },
      update: {
        workspaceMemberId: memberId,
        p256dh: sub.keys.p256dh,
        authKey: sub.keys.auth,
        lastSeenAt: new Date(),
      },
    });
  }

  async unsubscribe(endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
  }

  /** Fire a notification to every device the member has subscribed. Stale subs (410 Gone) are pruned.
   *  `urgency`: 'high' for call-style (immediate wake), 'normal' for everything else. iOS in particular
   *  needs urgency:'high' to ring the device when the PWA is fully closed. */
  async sendTo(memberId: string, payload: PushPayload, urgency: 'normal' | 'high' = 'normal') {
    if (!this.configured) return;
    const subs = await this.prisma.pushSubscription.findMany({ where: { workspaceMemberId: memberId } });
    if (subs.length === 0) return;
    const body = JSON.stringify(payload);
    const stale: string[] = [];
    const opts: any = { TTL: urgency === 'high' ? 30 : 60, urgency };
    await Promise.all(subs.map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.authKey } }, body, opts);
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) stale.push(s.endpoint);
        else this.log.warn(`Push send failed (${err?.statusCode}): ${err?.message}`);
      }
    }));
    if (stale.length > 0) {
      await this.prisma.pushSubscription.deleteMany({ where: { endpoint: { in: stale } } });
      this.log.log(`Pruned ${stale.length} stale push subscriptions`);
    }
  }

  /** Alias used by NotificationsService.dispatch() — clearer call site. */
  async sendToMember(memberId: string, payload: PushPayload, urgency: 'normal' | 'high' = 'normal') {
    return this.sendTo(memberId, payload, urgency);
  }

  async sendToMany(memberIds: string[], payload: PushPayload, urgency: 'normal' | 'high' = 'normal') {
    await Promise.all(memberIds.map(id => this.sendTo(id, payload, urgency)));
  }
}

// ───── Controller ────────────────────────────────────────────────────────────

@Controller('workspaces/:wid/push')
@UseGuards(WorkspaceGuard)
export class PushController {
  constructor(private svc: PushService) {}

  /** Client fetches the VAPID public key on first subscribe (so it doesn't need to be in env at build time). */
  @Get('public-key')
  publicKey() {
    return successResponse({ publicKey: this.svc.getPublicKey() });
  }

  @Post('subscribe')
  async subscribe(@Body() dto: PushSubscribeDto, @CurrentMember() m: any, @Headers('user-agent') ua?: string) {
    return successResponse(await this.svc.subscribe(m.id, dto, ua));
  }

  @Delete('subscribe')
  async unsubscribe(@Body() dto: PushUnsubscribeDto) {
    await this.svc.unsubscribe(dto.endpoint);
    return successResponse({ ok: true });
  }

  /** Sends a test notification to the current member — used by the Settings panel's "Send test" button. */
  @Post('test')
  async test(@CurrentMember() m: any) {
    await this.svc.sendToMember(m.id, {
      title: 'TaskForge test notification',
      body: 'If you see this, push is working on this device.',
      url: '/',
      tag: 'test',
    });
    return successResponse({ ok: true });
  }
}

@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
