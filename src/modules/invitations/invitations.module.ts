import {
  BadRequestException, ConflictException, Controller, Delete, ForbiddenException, Get,
  Inject, Injectable, Logger, Module, NotFoundException, Param, Post, Body, Req,
  UnauthorizedException, UseGuards, forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember, Public } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { successResponse } from '../../common/dto/response.dto';
import { EmailService } from '../../common/email/email.module';
import { AuthService } from '../auth/auth.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

// ───── DTOs ──────────────────────────────────────────────────────────────────

export class CreateInvitationDto {
  @IsEmail() @MaxLength(255) email: string = '';
  @IsString() @IsNotEmpty() @MaxLength(100) name: string = '';
  @IsOptional() @IsEnum(['admin', 'manager', 'employee'] as any) role?: 'admin' | 'manager' | 'employee';
  @IsOptional() @IsUUID() managerId?: string;
}

export class AcceptInvitationDto {
  @IsString() @MinLength(8) @MaxLength(128) password: string = '';
  @IsOptional() @IsString() @MaxLength(100) name?: string;
}

// ───── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class InvitationsService {
  private readonly log = new Logger('InvitationsService');

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private email: EmailService,
    @Inject(forwardRef(() => AuthService)) private auth: AuthService,
    @Inject(forwardRef(() => NotificationsService)) private notifications: NotificationsService,
  ) {}

  /** Create an invitation row, send the invite email, return a sanitized summary
   *  (without the plaintext token — that only goes out in the email). */
  async create(wid: string, dto: CreateInvitationDto, actorMemberId: string) {
    const email = dto.email.trim().toLowerCase();
    const role = dto.role || 'employee';
    const expiryDays = this.config.get<number>('email.inviteExpiryDays') || 7;

    // Block if user is already an active member here.
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const activeMember = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId: wid, userId: existingUser.id, isActive: true },
      });
      if (activeMember) throw new ConflictException('User is already a member of this workspace');
    }

    // Replace any existing pending invitation for this (workspace, email).
    // Means a re-invite supersedes an old one — the old token stops working.
    await this.prisma.invitation.deleteMany({
      where: { workspaceId: wid, email, acceptedAt: null },
    });

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + expiryDays * 86400000);

    const invitation = await this.prisma.invitation.create({
      data: {
        workspaceId: wid,
        email,
        name: dto.name.trim(),
        role: role as any,
        managerId: dto.managerId ?? null,
        tokenHash,
        expiresAt,
        invitedBy: actorMemberId,
      },
    });

    await this.sendInviteEmail(invitation.id, token);

    return this.sanitize(invitation);
  }

  /** List pending invitations (not yet accepted, not expired). Admin Settings UI uses this. */
  async list(wid: string) {
    const rows = await this.prisma.invitation.findMany({
      where: { workspaceId: wid, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    // Inviter names for display.
    const inviterIds = Array.from(new Set(rows.map(r => r.invitedBy)));
    const inviters = inviterIds.length === 0 ? [] : await this.prisma.workspaceMember.findMany({
      where: { id: { in: inviterIds } },
      include: { user: { select: { id: true, name: true } } },
    });
    const inviterMap = new Map(inviters.map(i => [i.id, i.user?.name || 'Someone']));
    return rows.map(r => ({ ...this.sanitize(r), inviterName: inviterMap.get(r.invitedBy) || 'Someone' }));
  }

  async revoke(wid: string, iid: string) {
    const inv = await this.prisma.invitation.findFirst({ where: { id: iid, workspaceId: wid } });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.acceptedAt) throw new BadRequestException('Invitation already accepted');
    await this.prisma.invitation.delete({ where: { id: iid } });
    return { ok: true };
  }

  /** Re-fire the same invitation: rotate the token (old link stops working) and resend the email. */
  async resend(wid: string, iid: string) {
    const inv = await this.prisma.invitation.findFirst({ where: { id: iid, workspaceId: wid } });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.acceptedAt) throw new BadRequestException('Invitation already accepted');

    const expiryDays = this.config.get<number>('email.inviteExpiryDays') || 7;
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + expiryDays * 86400000);

    const updated = await this.prisma.invitation.update({
      where: { id: iid },
      data: { tokenHash, expiresAt },
    });
    await this.sendInviteEmail(updated.id, token);
    return this.sanitize(updated);
  }

  /** Public — for the accept-invite page to render workspace + inviter context.
   *  Returns minimal info; reveals only what the holder of the token already knows
   *  (their own email). */
  async preview(token: string) {
    const inv = await this.findValidByToken(token);
    const [workspace, inviter] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: inv.workspaceId }, select: { name: true, slug: true } }),
      this.prisma.workspaceMember.findUnique({
        where: { id: inv.invitedBy }, include: { user: { select: { name: true } } },
      }),
    ]);
    const userExists = !!(await this.prisma.user.findUnique({
      where: { email: inv.email }, select: { id: true },
    }));
    return {
      workspaceName: workspace?.name || 'a workspace',
      workspaceSlug: workspace?.slug || null,
      inviterName: inviter?.user?.name || 'Someone',
      inviteeEmail: inv.email,
      inviteeName: inv.name,
      role: inv.role,
      userExists,
      expiresAt: inv.expiresAt,
    };
  }

  /** Public — accept the invitation. Creates the user if needed (using the
   *  caller-supplied password), or verifies the existing password if the email
   *  is already registered. Then creates / reactivates the WorkspaceMember row
   *  and marks the invitation accepted.
   *
   *  Returns the same session shape as /auth/login so the frontend can drop the
   *  invitee straight into the workspace. */
  async accept(token: string, dto: AcceptInvitationDto, ip?: string, ua?: string) {
    const inv = await this.findValidByToken(token);
    let user = await this.prisma.user.findUnique({ where: { email: inv.email } });

    if (user) {
      // Existing account — require their existing password. We don't change it.
      if (!user.passwordHash) {
        // OAuth-only account. Don't try to verify password; just trust the token,
        // which they only got via the invite email to this address.
      } else {
        const ok = await bcrypt.compare(dto.password, user.passwordHash);
        if (!ok) throw new UnauthorizedException('Incorrect password for existing account');
      }
      if (!user.isActive) throw new UnauthorizedException('Account is deactivated');
    } else {
      // New account.
      const finalName = (dto.name?.trim() || inv.name).slice(0, 100);
      user = await this.prisma.user.create({
        data: {
          email: inv.email,
          name: finalName,
          passwordHash: await bcrypt.hash(dto.password, 12),
          authProvider: 'email',
        },
      });
    }

    // Workspace membership: reactivate if previously deactivated, else create.
    const existingMember = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: inv.workspaceId, userId: user.id },
    });
    if (existingMember) {
      if (existingMember.isActive) {
        // Edge case: user accepted via a stale invite after already being added.
        // Treat as success — they're in.
      } else {
        await this.prisma.workspaceMember.update({
          where: { id: existingMember.id },
          data: { isActive: true, role: inv.role, managerId: inv.managerId, invitedBy: inv.invitedBy },
        });
      }
    } else {
      await this.prisma.workspaceMember.create({
        data: {
          workspaceId: inv.workspaceId,
          userId: user.id,
          role: inv.role,
          managerId: inv.managerId ?? null,
          timezone: 'UTC',
          isActive: true,
          invitedBy: inv.invitedBy,
        },
      });
    }

    // Mark accepted. Use updateMany so a concurrent accept attempt no-ops gracefully.
    await this.prisma.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });

    // Fire in-app notification to the new member for their first login.
    const ws = await this.prisma.workspace.findUnique({ where: { id: inv.workspaceId }, select: { name: true } });
    const newMember = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: inv.workspaceId, userId: user.id },
      select: { id: true },
    });
    if (newMember) {
      this.notifications.dispatch({
        workspaceId: inv.workspaceId,
        recipientMemberId: newMember.id,
        channel: 'invite',
        type: 'invite',
        title: 'You joined a new workspace',
        body: ws ? `Welcome to ${ws.name}` : 'Welcome',
        url: '/',
        entityType: 'workspace',
        entityId: inv.workspaceId,
      }).catch(() => {});
    }

    return this.auth.issueSessionForUser(user, ip, ua);
  }

  // ───── Internals ─────────────────────────────────────────────────────────

  private async findValidByToken(token: string) {
    if (!token) throw new BadRequestException('Missing token');
    const tokenHash = hashToken(token);
    const inv = await this.prisma.invitation.findFirst({ where: { tokenHash } });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.acceptedAt) throw new BadRequestException('Invitation already accepted');
    if (inv.expiresAt < new Date()) throw new BadRequestException('Invitation has expired');
    return inv;
  }

  private async sendInviteEmail(invitationId: string, token: string) {
    const inv = await this.prisma.invitation.findUnique({ where: { id: invitationId } });
    if (!inv) return;
    const [workspace, inviter] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: inv.workspaceId }, select: { name: true } }),
      this.prisma.workspaceMember.findUnique({
        where: { id: inv.invitedBy }, include: { user: { select: { name: true } } },
      }),
    ]);
    const appUrl = this.config.get<string>('app.appUrl') || 'http://localhost:3000';
    const acceptUrl = `${appUrl.replace(/\/$/, '')}/accept-invite/${token}`;
    await this.email.sendInviteEmail({
      to: inv.email,
      inviteeName: inv.name,
      inviterName: inviter?.user?.name || 'A teammate',
      workspaceName: workspace?.name || 'a workspace',
      acceptUrl,
      expiresAt: inv.expiresAt,
    });
  }

  /** Strip token_hash before returning to clients. */
  private sanitize(inv: any) {
    const { tokenHash, ...rest } = inv;
    return rest;
  }
}

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

// ───── Admin controller ──────────────────────────────────────────────────────

@Controller('workspaces/:wid/invitations')
@UseGuards(WorkspaceGuard, RolesGuard)
@Roles('admin')
@SkipThrottle()
export class WorkspaceInvitationsController {
  constructor(private svc: InvitationsService) {}

  @Post()
  async create(@Param('wid') wid: string, @Body() dto: CreateInvitationDto, @CurrentMember() actor: any, @Req() req: Request) {
    const inv = await this.svc.create(wid, dto, actor.id);
    (req as any).__auditData = {
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: inv.id,
      changes: { email: inv.email, role: inv.role },
    };
    return successResponse(inv);
  }

  @Get()
  async list(@Param('wid') wid: string) {
    return successResponse(await this.svc.list(wid));
  }

  @Delete(':iid')
  async revoke(@Param('wid') wid: string, @Param('iid') iid: string, @Req() req: Request) {
    const out = await this.svc.revoke(wid, iid);
    (req as any).__auditData = {
      action: 'invitation.revoked',
      entityType: 'invitation',
      entityId: iid,
    };
    return successResponse(out);
  }

  @Post(':iid/resend')
  async resend(@Param('wid') wid: string, @Param('iid') iid: string, @Req() req: Request) {
    const inv = await this.svc.resend(wid, iid);
    (req as any).__auditData = {
      action: 'invitation.resent',
      entityType: 'invitation',
      entityId: iid,
      changes: { email: inv.email },
    };
    return successResponse(inv);
  }
}

// ───── Public controller (no JWT) ────────────────────────────────────────────

@Controller('invitations')
export class PublicInvitationsController {
  constructor(private svc: InvitationsService) {}

  @Public()
  @Get('preview/:token')
  async preview(@Param('token') token: string) {
    return successResponse(await this.svc.preview(token));
  }

  // Tighter throttle on accept to slow brute-force token guessing.
  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('accept/:token')
  async accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const ua = req.headers['user-agent'];
    return successResponse(await this.svc.accept(token, dto, ip, ua));
  }
}

@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => NotificationsModule)],
  controllers: [WorkspaceInvitationsController, PublicInvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
