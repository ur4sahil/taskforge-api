import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators';

const HIERARCHY: Record<string, number> = { admin: 3, manager: 2, employee: 1 };

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const m = ctx.switchToHttp().getRequest().workspaceMember;
    if (!m) throw new ForbiddenException('Workspace context required');

    const memberLevel = HIERARCHY[m.role] || 0;
    const hasRole = roles.some((r: string) => memberLevel >= (HIERARCHY[r] || 0));
    if (!hasRole) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
