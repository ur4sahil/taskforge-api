import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators';
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) { super(); }
  canActivate(ctx: ExecutionContext) { return this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]) || (super.canActivate(ctx) as boolean | Promise<boolean>); }
  handleRequest<T>(err: Error | null, user: T | false): T { if (err || !user) throw err || new UnauthorizedException('Invalid token'); return user; }
}
