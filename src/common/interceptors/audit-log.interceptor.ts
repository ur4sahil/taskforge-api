import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next.handle();

    return next.handle().pipe(tap(() => {
      const a = req.__auditData;
      const m = req.workspaceMember;
      if (!a || !m) return;

      this.prisma.auditLog.create({
        data: {
          workspaceId: m.workspaceId,
          actorId: m.id,
          action: a.action,
          entityType: a.entityType,
          entityId: a.entityId,
          changes: a.changes as any,
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        },
      }).catch((e: any) => this.logger.error(e.message));
    }));
  }
}
