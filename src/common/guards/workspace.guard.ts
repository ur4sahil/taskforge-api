import { Injectable, CanActivate, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Auth required');

    const wid = req.params.wid;
    if (!wid) throw new ForbiddenException('Workspace ID required');

    // One round trip: the workspace plus this user's membership row (every
    // request passes through here, and each statement costs ~78 ms in prod).
    const found = await this.prisma.workspace.findUnique({
      where: { id: wid },
      include: { members: { where: { userId: user.userId }, take: 1 } },
    });
    if (!found) throw new NotFoundException('Workspace not found');
    const { members, ...ws } = found;

    const m = members[0];
    if (!m) throw new ForbiddenException('Not a member');
    if (!m.isActive) throw new ForbiddenException('Deactivated');

    req.workspaceMember = {
      id: m.id, userId: m.userId, workspaceId: m.workspaceId,
      role: m.role, managerId: m.managerId, timezone: m.timezone,
    };
    req.workspace = ws;
    return true;
  }
}
