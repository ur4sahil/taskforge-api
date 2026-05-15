// Unit tests for WorkspacesService — Prisma mocked. Focuses on inviteMember
// branches (new-user, existing-user-link, conflict-on-active, reactivate-dormant)
// which are tricky to enumerate at the HTTP layer.
import { WorkspacesService } from '../../src/modules/workspaces/workspaces.service';
import { ConflictException } from '@nestjs/common';

function makeService(overrides: any = {}) {
  const prisma: any = {
    workspace: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    workspaceMember: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    task: { count: jest.fn().mockResolvedValue(0) },
    ...overrides,
  };
  return { service: new WorkspacesService(prisma), prisma };
}

describe('WorkspacesService.inviteMember', () => {
  const wid = 'workspace-1';

  it('creates a new user + member when email is unknown and returns tempPassword', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'new-user', email: 'new@x.com', name: 'New' });
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.create.mockResolvedValue({ id: 'm1', userId: 'new-user', role: 'employee', isActive: true });

    const out = await service.inviteMember(wid, { email: 'new@x.com', name: 'New', role: 'employee' } as any);

    expect(out.isNewUser).toBe(true);
    expect(out.tempPassword).toEqual(expect.any(String));
    expect(out.tempPassword!.length).toBeGreaterThanOrEqual(8);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceMember.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: wid, userId: 'new-user', role: 'employee', isActive: true }),
    }));
  });

  it('lowercases email before lookup AND user.create', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'u1', email: 'mixed@x.com', name: 'M' });
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.create.mockResolvedValue({});

    await service.inviteMember(wid, { email: 'MixedCase@X.com', name: 'M', role: 'employee' } as any);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'mixedcase@x.com' } });
    expect(prisma.user.create.mock.calls[0][0].data.email).toBe('mixedcase@x.com');
  });

  it('hashes the generated password (not plaintext)', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'u1', email: 'new@x.com', name: 'N' });
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.create.mockResolvedValue({});

    const out = await service.inviteMember(wid, { email: 'new@x.com', name: 'N', role: 'employee' } as any);
    const stored = prisma.user.create.mock.calls[0][0].data.passwordHash;
    expect(stored).not.toBe(out.tempPassword);
    expect(stored).toMatch(/^\$2[aby]\$/);
  });

  it('links an existing user without creating a new user row, tempPassword is null', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'existing', email: 'a@x.com', name: 'A' });
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.create.mockResolvedValue({ id: 'm1', userId: 'existing', role: 'manager', isActive: true });

    const out = await service.inviteMember(wid, { email: 'a@x.com', name: 'Renamed', role: 'manager' } as any);

    expect(out.isNewUser).toBe(false);
    expect(out.tempPassword).toBeNull();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.create).toHaveBeenCalled();
  });

  it('throws ConflictException when user is already an active member', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.workspaceMember.findFirst.mockResolvedValue({ id: 'existing-m', userId: 'u1', isActive: true });

    await expect(service.inviteMember(wid, { email: 'a@x.com', name: 'A', role: 'employee' } as any))
      .rejects.toBeInstanceOf(ConflictException);
    expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
  });

  it('reactivates dormant member instead of creating a duplicate row', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.workspaceMember.findFirst.mockResolvedValue({ id: 'm-dormant', userId: 'u1', isActive: false });
    prisma.workspaceMember.update.mockResolvedValue({ id: 'm-dormant', isActive: true, role: 'admin' });

    const out = await service.inviteMember(wid, { email: 'a@x.com', name: 'A', role: 'admin', managerId: 'mgr-1' } as any);

    expect(out.isNewUser).toBe(false);
    expect(out.tempPassword).toBeNull();
    expect(out.member.id).toBe('m-dormant');
    expect(prisma.workspaceMember.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'm-dormant' },
      data: expect.objectContaining({ isActive: true, role: 'admin', managerId: 'mgr-1' }),
    }));
    expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
  });

  it('defaults role to "employee" when omitted', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.create.mockResolvedValue({});

    await service.inviteMember(wid, { email: 'a@x.com', name: 'A' } as any);
    expect(prisma.workspaceMember.create.mock.calls[0][0].data.role).toBe('employee');
  });
});
