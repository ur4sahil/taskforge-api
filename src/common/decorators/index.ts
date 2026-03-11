import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
export interface AuthenticatedUser { userId: string; email: string; name: string; }
export const CurrentUser = createParamDecorator((data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => { const u = ctx.switchToHttp().getRequest().user; return data ? u?.[data] : u; });
export interface CurrentWorkspaceMember { id: string; userId: string; workspaceId: string; role: WorkspaceRole; managerId: string | null; timezone: string; }
export const CurrentMember = createParamDecorator((data: keyof CurrentWorkspaceMember | undefined, ctx: ExecutionContext) => { const m = ctx.switchToHttp().getRequest().workspaceMember; return data ? m?.[data] : m; });
export const ROLES_KEY = 'roles';
export const Roles = (...roles: WorkspaceRole[]) => SetMetadata(ROLES_KEY, roles);
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
