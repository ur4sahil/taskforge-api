// Unit tests for AuthService — Prisma + JwtService + ConfigService are mocked
// so each test exercises business logic in isolation (e.g., email lowercasing,
// hash-then-store flow, refresh token rotation).
import { AuthService } from '../../src/modules/auth/auth.service';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

function makeService(prismaOverrides: any = {}, jwtOverrides: any = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    refreshToken: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    workspaceMember: { findMany: jest.fn().mockResolvedValue([]) },
    ...prismaOverrides,
  };
  const jwt: any = {
    sign: jest.fn().mockReturnValue('signed-access-token'),
    ...jwtOverrides,
  };
  const config: any = { get: jest.fn().mockImplementation((k: string) => (k === 'auth.jwtAccessSecret' ? 'secret' : '15m')) };
  return { service: new AuthService(prisma, jwt, config), prisma, jwt, config };
}

describe('AuthService', () => {
  describe('signup', () => {
    it('lowercases email before lookup AND store', async () => {
      const { service, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' });
      prisma.refreshToken.create.mockResolvedValue({});
      await service.signup({ email: 'A@B.COM', password: 'P@ssw0rd1', name: 'A' } as any);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
      expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'a@b.com' }) }));
    });

    it('throws ConflictException when email already exists', async () => {
      const { service, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.signup({ email: 'a@b.com', password: 'pw', name: 'A' } as any))
        .rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('bcrypt-hashes the password (12 rounds) — assert the stored value is NOT plaintext', async () => {
      const { service, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' });
      prisma.refreshToken.create.mockResolvedValue({});
      await service.signup({ email: 'a@b.com', password: 'SuperSecret1!', name: 'A' } as any);
      const callArg = prisma.user.create.mock.calls[0][0];
      expect(callArg.data.passwordHash).not.toBe('SuperSecret1!');
      expect(callArg.data.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt prefix
    });

    it('returns access+refresh tokens + user shape', async () => {
      const { service, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A' });
      prisma.refreshToken.create.mockResolvedValue({});
      const out = await service.signup({ email: 'a@b.com', password: 'pw', name: 'A' } as any);
      expect(out).toMatchObject({
        accessToken: 'signed-access-token',
        refreshToken: expect.any(String),
        user: { id: 'u1', email: 'a@b.com', name: 'A' },
        workspaces: [],
      });
      expect(out.refreshToken).not.toBe('signed-access-token');
      expect(out.refreshToken.length).toBeGreaterThan(40);
    });
  });

  describe('login', () => {
    it('rejects when user not found', async () => {
      const { service, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login({ email: 'no@one.com', password: 'pw' } as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects deactivated user even with correct password', async () => {
      const { service, prisma } = makeService();
      const hash = await bcrypt.hash('correct', 4);
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', passwordHash: hash, isActive: false });
      await expect(service.login({ email: 'a@b.com', password: 'correct' } as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects wrong password', async () => {
      const { service, prisma } = makeService();
      const hash = await bcrypt.hash('right-password', 4);
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', passwordHash: hash, isActive: true });
      await expect(service.login({ email: 'a@b.com', password: 'wrong-password' } as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns tokens + user + workspaces on success', async () => {
      const { service, prisma } = makeService();
      const hash = await bcrypt.hash('right', 4);
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', name: 'A', avatarUrl: null, authProvider: 'email', passwordHash: hash, isActive: true });
      prisma.refreshToken.create.mockResolvedValue({});
      const out = await service.login({ email: 'A@b.COM', password: 'right' } as any);
      expect(out.accessToken).toBe('signed-access-token');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
    });
  });

  describe('refresh', () => {
    it('rejects unknown token', async () => {
      const { service, prisma } = makeService();
      prisma.refreshToken.findFirst.mockResolvedValue(null);
      await expect(service.refresh({ refreshToken: 'nope' } as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects expired token', async () => {
      const { service, prisma } = makeService();
      prisma.refreshToken.findFirst.mockResolvedValue({
        id: 'rt1', expiresAt: new Date(Date.now() - 60_000), userId: 'u1', user: { email: 'a@b.com' },
      });
      await expect(service.refresh({ refreshToken: 'old' } as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('revokes the old refresh token before issuing new ones', async () => {
      const { service, prisma } = makeService();
      prisma.refreshToken.findFirst.mockResolvedValue({
        id: 'rt1', expiresAt: new Date(Date.now() + 60_000), userId: 'u1', user: { email: 'a@b.com' },
      });
      prisma.refreshToken.create.mockResolvedValue({});
      await service.refresh({ refreshToken: 'valid' } as any);
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt1' }, data: { isRevoked: true },
      });
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the given refresh token by hash', async () => {
      const { service, prisma } = makeService();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      await service.logout('the-token-string');
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: expect.any(String) },
        data: { isRevoked: true },
      });
      // The hash stored should NOT be the plaintext token.
      const call = prisma.refreshToken.updateMany.mock.calls[0][0];
      expect(call.where.tokenHash).not.toBe('the-token-string');
    });
  });
});
