import { Injectable, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { SignupDto, LoginDto, RefreshTokenDto, AuthTokens, AuthResponse } from './dto';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private config: ConfigService) {}

  async signup(dto: SignupDto, ip?: string, ua?: string): Promise<AuthResponse> {
    if (await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } })) throw new ConflictException('Email taken');
    const user = await this.prisma.user.create({ data: { email: dto.email.toLowerCase(), passwordHash: await bcrypt.hash(dto.password, 12), name: dto.name, authProvider: 'email' } });
    const tokens = await this.genTokens(user.id, user.email, ip, ua);
    return { ...tokens, user: { id: user.id, email: user.email, name: user.name, avatarUrl: null, authProvider: 'email' }, workspaces: [] };
  }

  async login(dto: LoginDto, ip?: string, ua?: string): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!user?.passwordHash || !user.isActive) throw new UnauthorizedException('Invalid credentials');
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Invalid credentials');
    const tokens = await this.genTokens(user.id, user.email, ip, ua);
    const workspaces = await this.getWorkspaces(user.id);
    return { ...tokens, user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, authProvider: user.authProvider }, workspaces };
  }

  async refresh(dto: RefreshTokenDto, ip?: string, ua?: string): Promise<AuthTokens> {
    const hash = this.hashTok(dto.refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({ where: { tokenHash: hash, isRevoked: false }, include: { user: true } });
    if (!stored || stored.expiresAt < new Date()) throw new UnauthorizedException('Invalid refresh token');
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { isRevoked: true } });
    return this.genTokens(stored.userId, stored.user.email, ip, ua);
  }

  async logout(token: string) { await this.prisma.refreshToken.updateMany({ where: { tokenHash: this.hashTok(token) }, data: { isRevoked: true } }); }

  private async genTokens(userId: string, email: string, ip?: string, ua?: string): Promise<AuthTokens> {
    const accessToken = this.jwt.sign({ sub: userId, email }, { secret: this.config.get('auth.jwtAccessSecret'), expiresIn: this.config.get('auth.jwtAccessExpiry') || '15m' });
    const refreshToken = randomBytes(40).toString('hex');
    await this.prisma.refreshToken.create({ data: { userId, tokenHash: this.hashTok(refreshToken), expiresAt: new Date(Date.now() + 7 * 86400000), ipAddress: ip, userAgent: ua } });
    return { accessToken, refreshToken };
  }

  private hashTok(t: string) { return createHash('sha256').update(t).digest('hex'); }
  private async getWorkspaces(userId: string) {
    const ms = await this.prisma.workspaceMember.findMany({ where: { userId, isActive: true }, include: { workspace: true } });
    return ms.map(m => ({ id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug, role: m.role }));
  }
}
