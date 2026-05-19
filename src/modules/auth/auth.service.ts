import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SignupDto, LoginDto, RefreshTokenDto } from './dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async signup(dto: SignupDto, ip?: string, ua?: string) {
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
      where: { tokenHash: hash, isRevoked: false },
      include: { user: true },
    });
    if (!stored || stored.expiresAt < new Date()) throw new UnauthorizedException('Invalid refresh token');
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { isRevoked: true } });
    return this.generateTokens(stored.userId, stored.user.email, ip, ua);
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

  async logout(token: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(token) },
      data: { isRevoked: true },
    });
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

  private async generateTokens(userId: string, email: string, ip?: string, ua?: string) {
    const accessToken = this.jwt.sign(
      { sub: userId, email },
      { secret: this.config.get('auth.jwtAccessSecret'), expiresIn: this.config.get('auth.jwtAccessExpiry') || '15m' },
    );
    const refreshToken = randomBytes(40).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
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
