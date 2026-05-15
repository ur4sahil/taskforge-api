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
      }).catch((e: any) => {
        // FK violations happen legitimately when a request deletes the workspace
        // or actor — the audit row references rows that no longer exist. Quietly
        // drop those, since by definition there's no audit history to preserve
        // for an entity that no longer exists. Anything else is a real surprise.
        if (e?.code === 'P2003' || /Foreign key constraint/i.test(e?.message || '')) {
          this.logger.debug(`audit log dropped: ${a.action} ${a.entityType}:${a.entityId} — referenced row gone`);
          return;
        }
        this.logger.error(`audit log failed: ${e?.message || e}`);
      });
    }));
  }
}
