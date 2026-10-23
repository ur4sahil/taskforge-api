import {
  Injectable, Logger, BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../../common/email/email.module';
import { SignupDto, LoginDto, RefreshTokenDto, ChangePasswordDto } from './dto';
import { signupEnabled } from '../../config';

/** Forgot-password links live this long. Short on purpose: the raw token is
 *  sitting in an inbox. */
export const PASSWORD_RESET_EXPIRY_MINUTES = 60;

/** A refresh token spent on /auth/refresh is accepted once more for this long,
 *  as long as the token issued in its place has never been used. Covers the
 *  response that never arrived: the page navigated, iOS suspended the PWA, or
 *  the network dropped mid-request. Without it that session is unrecoverable. */
export const REFRESH_REUSE_GRACE_MS = 60_000;

/** Revoked / expired refresh tokens older than this are pruned opportunistically. */
const REFRESH_TOKEN_PRUNE_AGE_MS = 30 * 86400000;

@Injectable()
export class AuthService {
  private readonly log = new Logger('AuthService');

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private email: EmailService,
  ) {}

  async signup(dto: SignupDto, ip?: string, ua?: string) {
    if (!signupEnabled()) throw new ForbiddenException('Sign-ups are invite-only. Ask your workspace admin for an invitation.');
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (existing) throw new ConflictException('Email taken');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash: await bcrypt.hash(dto.password, 12),
        name: dto.name,
        authProvider: 'email',
      },
    });

    const tokens = await this.generateTokens(user.id, user.email, ip, ua);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: null, authProvider: 'email' },
      workspaces: [],
    };
  }

  async login(dto: LoginDto, ip?: string, ua?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!user || !user.passwordHash || !user.isActive) throw new UnauthorizedException('Invalid credentials');
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.generateTokens(user.id, user.email, ip, ua);
    const workspaces = await this.getUserWorkspaces(user.id);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, authProvider: user.authProvider },
      workspaces,
    };
  }

  async refresh(dto: RefreshTokenDto, ip?: string, ua?: string) {
    const hash = this.hashToken(dto.refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: hash },
      include: { user: true },
    });
    if (!stored || stored.expiresAt < new Date()) throw new UnauthorizedException('Invalid refresh token');
    // A deactivated user keeps a valid-looking refresh token until it expires;
    // without this check they could mint access tokens for 7 more days.
    if (!stored.user.isActive) throw new UnauthorizedException('Account deactivated');

    if (!stored.isRevoked) {
      // Spend the token and record its successor in one transaction. The
      // conditional update takes the row lock, so a concurrent refresh with the
      // same token waits, finds it spent, and goes down the grace path below
      // with the successor already committed.
      const nextId = randomUUID();
      const spent = await this.prisma.$transaction(async tx => {
        const claim = await tx.refreshToken.updateMany({
          where: { id: stored.id, isRevoked: false },
          data: { isRevoked: true, rotatedAt: new Date(), replacedById: nextId },
        });
        if (claim.count !== 1) return null;
        return this.generateTokens(stored.userId, stored.user.email, ip, ua, tx, nextId);
      });
      if (spent) return spent;
    }
    return this.reissueWithinGrace(stored.id, stored.userId, stored.user.email, ip, ua);
  }

  /** The token was already spent. Accept it once more only if it was spent by a
   *  refresh under REFRESH_REUSE_GRACE_MS ago and its successor was never used
   *  (so the client never received it). Logout and password changes revoke
   *  without `rotatedAt`, and revoke the successor too, so neither passes. The
   *  unused successor is revoked so only the newly issued token stays live. */
  private async reissueWithinGrace(id: string, userId: string, email: string, ip?: string, ua?: string) {
    const nextId = randomUUID();
    const out = await this.prisma.$transaction(async tx => {
      const spent = await tx.refreshToken.findUnique({ where: { id } });
      if (!spent?.rotatedAt || !spent.replacedById) return null;
      if (Date.now() - spent.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS) return null;
      const dropped = await tx.refreshToken.updateMany({
        where: { id: spent.replacedById, isRevoked: false },
        data: { isRevoked: true },
      });
      if (dropped.count !== 1) return null;
      await tx.refreshToken.update({ where: { id }, data: { replacedById: nextId } });
      return this.generateTokens(userId, email, ip, ua, tx, nextId);
    });
    if (!out) throw new UnauthorizedException('Invalid refresh token');
    this.log.log(`refresh token re-issued within grace for user ${userId}`);
    return out;
  }

  async loginWithGoogle(profile: { email: string; name: string; avatarUrl: string | null }, ip?: string, ua?: string) {
    let user = await this.prisma.user.findUnique({ where: { email: profile.email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          authProvider: 'google',
          passwordHash: null,
        },
      });
    } else if (!user.avatarUrl && profile.avatarUrl) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: { avatarUrl: profile.avatarUrl } });
    }
    if (!user.isActive) throw new UnauthorizedException('Account deactivated');
    const tokens = await this.generateTokens(user.id, user.email, ip, ua);
    const workspaces = await this.getUserWorkspaces(user.id);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, authProvider: user.authProvider },
      workspaces,
    };
  }

  async logout(token: string, userId?: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(token) },
      data: { isRevoked: true },
    });
    // Opportunistic hygiene: drop this user's dead tokens (revoked, or expired)
    // once they're a month old. Cheap, and keeps refresh_tokens from growing
    // forever without a dedicated worker.
    if (userId) {
      const cutoff = new Date(Date.now() - REFRESH_TOKEN_PRUNE_AGE_MS);
      await this.prisma.refreshToken.deleteMany({
        where: {
          userId,
          createdAt: { lt: cutoff },
          OR: [{ isRevoked: true }, { expiresAt: { lt: new Date() } }],
        },
      }).catch((e: any) => this.log.warn(`refresh token prune failed: ${e?.message || e}`));
    }
  }

  // ───── Forgot / reset password ───────────────────────────────────────────

  /** Always resolves to the same message so the endpoint cannot be used to
   *  discover which emails have accounts. Side effects only happen for a real,
   *  active account: previous unused tokens are invalidated, a fresh one is
   *  stored as sha256, and the raw token goes out by email. Google-only
   *  accounts get a different email (there's no password to reset) but the
   *  same response. Emails are sent fire-and-forget so the response time does
   *  not depend on the mail provider either. */
  async forgotPassword(email: string): Promise<{ message: string }> {
    const message = 'If an account exists for that email, we have sent password reset instructions.';
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !user.isActive) return { message };

    const appUrl = (this.config.get<string>('app.appUrl') || 'http://localhost:3000').replace(/\/$/, '');

    if (!user.passwordHash) {
      this.email.sendPasswordResetNotApplicable(user.email, user.name, `${appUrl}/auth/login`)
        .catch((e: any) => this.log.error(`google-only notice failed for ${user.email}: ${e?.message || e}`));
      return { message };
    }

    const token = randomBytes(32).toString('hex');
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hashToken(token),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60000),
        },
      }),
    ]);

    this.email.sendPasswordReset(user.email, user.name, `${appUrl}/auth/reset-password/${token}`, PASSWORD_RESET_EXPIRY_MINUTES)
      .catch((e: any) => this.log.error(`password reset email failed for ${user.email}: ${e?.message || e}`));
    return { message };
  }

  /** For the reset page to show state before asking for a password. Reveals
   *  only a masked email — the holder of the link already knows the address. */
  async previewPasswordReset(token: string) {
    const { user } = await this.findValidResetToken(token);
    return { valid: true, email: maskEmail(user.email) };
  }

  /** Consume a reset link: set the new password, burn the token, kill every
   *  existing session, and sign the user in fresh (same shape as login). */
  async resetPassword(token: string, password: string, ip?: string, ua?: string) {
    const reset = await this.findValidResetToken(token);
    if (!reset.user.isActive) throw new UnauthorizedException('Account deactivated');
    const passwordHash = await bcrypt.hash(password, 12);

    // updateMany with usedAt: null makes a concurrent second submit of the same
    // link lose the race instead of resetting twice.
    const [used] = await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({ where: { userId: reset.userId, isRevoked: false }, data: { isRevoked: true } }),
    ]);
    if (used.count !== 1) throw new BadRequestException('Reset link has already been used');

    return this.issueSessionForUser(reset.user, ip, ua);
  }

  /** Logged-in password change. Revokes every refresh token (other devices get
   *  signed out) and hands back a new pair so the calling client stays in. */
  async changePassword(userId: string, dto: ChangePasswordDto, ip?: string, ua?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid user');
    if (!user.passwordHash) throw new BadRequestException('This account signs in with Google and has no password to change');
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      // 400, not 401: a 401 on an authenticated route reads as "session dead"
      // to the web client's interceptor and would bounce the user to login.
      throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } }),
    ]);
    return this.generateTokens(user.id, user.email, ip, ua);
  }

  private async findValidResetToken(token: string) {
    if (!token) throw new BadRequestException('Missing token');
    const reset = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });
    if (!reset) throw new NotFoundException('Reset link is invalid');
    if (reset.usedAt) throw new BadRequestException('Reset link has already been used');
    if (reset.expiresAt < new Date()) throw new BadRequestException('Reset link has expired');
    return reset;
  }

  /** Mint a fresh session for a user without going through login. Used by the
   *  invitation accept flow so the invitee lands in their new workspace already
   *  authenticated. Matches the return shape of login() exactly so the frontend
   *  treats it like any other sign-in. */
  async issueSessionForUser(user: { id: string; email: string; name: string; avatarUrl: string | null; authProvider: any }, ip?: string, ua?: string) {
    const tokens = await this.generateTokens(user.id, user.email, ip, ua);
    const workspaces = await this.getUserWorkspaces(user.id);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, authProvider: user.authProvider },
      workspaces,
    };
  }

  private async generateTokens(userId: string, email: string, ip?: string, ua?: string, db: Pick<PrismaService, 'refreshToken'> = this.prisma, id?: string) {
    const accessToken = this.jwt.sign(
      { sub: userId, email },
      { secret: this.config.get('auth.jwtAccessSecret'), expiresIn: this.config.get('auth.jwtAccessExpiry') || '15m' },
    );
    const refreshToken = randomBytes(40).toString('hex');
    await db.refreshToken.create({
      data: {
        ...(id ? { id } : {}),
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 86400000),
        ipAddress: ip || null,
        userAgent: ua || null,
      },
    });
    return { accessToken, refreshToken };
  }

  private hashToken(t: string) {
    return createHash('sha256').update(t).digest('hex');
  }

  private async getUserWorkspaces(userId: string) {
    const ms = await this.prisma.workspaceMember.findMany({
      where: { userId, isActive: true },
      include: { workspace: true },
    });
    return ms.map((m: any) => ({ id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug, role: m.role }));
  }
}

/** 'sahil@example.com' → 's***l@example.com'. Enough for "is this the account
 *  I meant?" without handing the full address to whoever holds the link. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}
