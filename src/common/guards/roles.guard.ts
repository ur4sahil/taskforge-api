import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators';
const H: Record<WorkspaceRole, number> = { admin: 3, manager: 2, employee: 1 };
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<WorkspaceRole[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const m = ctx.switchToHttp().getRequest().workspaceMember;
    if (!m || !roles.some(r => H[m.role] >= H[r])) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
