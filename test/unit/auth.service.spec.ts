// Unit tests for AuthService — Prisma + JwtService + ConfigService are mocked
// so each test exercises business logic in isolation (e.g., email lowercasing,
// hash-then-store flow, refresh token rotation).
import { AuthService } from '../../src/modules/auth/auth.service';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

function makeService(prismaOverrides: any = {}, jwtOverrides: any = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    refreshToken: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    workspaceMember: { findMany: jest.fn().mockResolvedValue([]) },
    ...prismaOverrides,
  };
  // Interactive transactions run against the same mocks.
  prisma.$transaction = jest.fn().mockImplementation((fn: any) => fn(prisma));
  const jwt: any = {
    sign: jest.fn().mockReturnValue('signed-access-token'),
    ...jwtOverrides,
  };
  const config: any = { get: jest.fn().mockImplementation((k: string) => (k === 'auth.jwtAccessSecret' ? 'secret' : '15m')) };
  const email: any = {
    sendPasswordReset: jest.fn().mockResolvedValue({ sent: false }),
    sendPasswordResetNotApplicable: jest.fn().mockResolvedValue({ sent: false }),
  };
  return { service: new AuthService(prisma, jwt, config, email), prisma, jwt, config, email };
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

    it('rejects a valid token whose user has been deactivated', async () => {
      const { service, prisma } = makeService();
      prisma.refreshToken.findFirst.mockResolvedValue({
        id: 'rt1', expiresAt: new Date(Date.now() + 60_000), userId: 'u1', user: { email: 'a@b.com', isActive: false },
      });
      await expect(service.refresh({ refreshToken: 'valid' } as any))
        .rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('spends the old token (conditionally) and issues its successor with the recorded id', async () => {
      const { service, prisma } = makeService();
      prisma.refreshToken.findFirst.mockResolvedValue({
        id: 'rt1', isRevoked: false, expiresAt: new Date(Date.now() + 60_000), userId: 'u1', user: { email: 'a@b.com', isActive: true },
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.refreshToken.create.mockResolvedValue({});
      await service.refresh({ refreshToken: 'valid' } as any);
      const claim = prisma.refreshToken.updateMany.mock.calls[0][0];
      expect(claim.where).toEqual({ id: 'rt1', isRevoked: false });
      expect(claim.data).toMatchObject({ isRevoked: true, rotatedAt: expect.any(Date), replacedById: expect.any(String) });
      expect(prisma.refreshToken.create.mock.calls[0][0].data.id).toBe(claim.data.replacedById);
    });

    it('rejects a token revoked by logout (no rotatedAt) without issuing anything', async () => {
      const { service, prisma } = makeService();
      prisma.refreshToken.findFirst.mockResolvedValue({
        id: 'rt1', isRevoked: true, expiresAt: new Date(Date.now() + 60_000), userId: 'u1', user: { email: 'a@b.com', isActive: true },
      });
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt1', isRevoked: true, rotatedAt: null, replacedById: null });
      await expect(service.refresh({ refreshToken: 'used' } as any)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
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
