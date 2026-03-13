import { Injectable, Module, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsDateString } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';

export class AuditFilterDto { @IsOptional() @IsString() action?: string; @IsOptional() @IsString() entityType?: string; @IsOptional() @IsString() actorId?: string; }

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}
  async findAll(wid: string, f: AuditFilterDto, page: number, perPage: number) {
    const where: any = { workspaceId: wid };
    if (f.action) where.action = { contains: f.action };
    if (f.entityType) where.entityType = f.entityType;
    if (f.actorId) where.actorId = f.actorId;
    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, include: { actor: { include: { user: { select: { name: true } } } } }, skip: (page - 1) * perPage, take: perPage, orderBy: { createdAt: 'desc' } }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { logs, meta: paginationMeta(total, page, perPage) };
  }
}

@Controller('workspaces/:wid/audit-logs') @UseGuards(WorkspaceGuard, RolesGuard) @Roles('admin')
export class AuditController {
  constructor(private svc: AuditService) {}
  @Get() async all(@Param('wid') w: string, @Query() f: AuditFilterDto, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, f, p.page, p.perPage); return successResponse(r.logs, r.meta); }
}

@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
