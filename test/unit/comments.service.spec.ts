// Unit tests for CommentsService.delete — Prisma + NotificationsService mocked.
// Covers ownership/role authorization branches without booting the full HTTP layer.
import { CommentsService } from '../../src/modules/comments/comments.module';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

function makeService() {
  const prisma: any = {
    comment: { findFirst: jest.fn(), delete: jest.fn() },
  };
  const notifications: any = { dispatch: jest.fn() };
  return { service: new CommentsService(prisma, notifications), prisma };
}

describe('CommentsService.delete', () => {
  const wid = 'ws-1';
  const tid = 'task-1';
  const cid = 'comment-1';

  it('throws NotFoundException when no matching comment exists', async () => {
    const { service, prisma } = makeService();
    prisma.comment.findFirst.mockResolvedValue(null);
    await expect(service.delete(wid, tid, cid, 'actor-m', 'employee'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });

  it('allows the comment author (employee) to delete their own comment', async () => {
    const { service, prisma } = makeService();
    prisma.comment.findFirst.mockResolvedValue({ id: cid, authorId: 'm-author' });
    prisma.comment.delete.mockResolvedValue({});
    await service.delete(wid, tid, cid, 'm-author', 'employee');
    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: cid } });
  });

  it('forbids non-author non-admin from deleting', async () => {
    const { service, prisma } = makeService();
    prisma.comment.findFirst.mockResolvedValue({ id: cid, authorId: 'm-someone-else' });
    await expect(service.delete(wid, tid, cid, 'm-actor', 'employee'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });

  it('forbids non-author manager (no manager-of-author privilege at this layer)', async () => {
    const { service, prisma } = makeService();
    prisma.comment.findFirst.mockResolvedValue({ id: cid, authorId: 'm-employee' });
    await expect(service.delete(wid, tid, cid, 'm-manager', 'manager'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });

  it('allows admin to delete a comment they did not author', async () => {
    const { service, prisma } = makeService();
    prisma.comment.findFirst.mockResolvedValue({ id: cid, authorId: 'm-employee' });
    prisma.comment.delete.mockResolvedValue({});
    await service.delete(wid, tid, cid, 'm-admin', 'admin');
    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: cid } });
  });

  it('scopes lookup by workspaceId AND taskId — wrong task does not match', async () => {
    const { service, prisma } = makeService();
    prisma.comment.findFirst.mockResolvedValue(null);
    await expect(service.delete(wid, 'wrong-task', cid, 'm-admin', 'admin'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.comment.findFirst).toHaveBeenCalledWith({
      where: { id: cid, taskId: 'wrong-task', task: { workspaceId: wid } },
      select: { id: true, authorId: true },
    });
  });
});
