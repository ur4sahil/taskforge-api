import { Injectable, Module, Controller, Get, Param, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember, Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}
  async personal(wid: string, mid: string) {
    const today = new Date(new Date().setHours(0, 0, 0, 0));
    const tomorrow = new Date(today.getTime() + 86400000);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [open, overdue, dueToday, done7d] = await Promise.all([
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, status: { not: 'done' }, deletedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, status: { not: 'done' }, dueDate: { lt: today }, deletedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, dueDate: { gte: today, lt: tomorrow }, deletedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, status: 'done', completedAt: { gte: weekAgo }, deletedAt: null } }),
    ]);
    return { open, overdue, dueToday, completedThisWeek: done7d };
  }
  async team(wid: string, managerId: string) {
    const reports = await this.prisma.workspaceMember.findMany({ where: { workspaceId: wid, managerId, isActive: true }, include: { user: { select: { name: true } } } });
    const stats = await Promise.all(reports.map(async (r: any) => ({ name: r.user.name, ...await this.personal(wid, r.id) })));
    return { teamSize: reports.length, members: stats, caveat: 'Task counts do not reflect quality or complexity of work.' };
  }
  async workspace(wid: string) {
    const [total, open, overdue, byStatus] = await Promise.all([
      this.prisma.task.count({ where: { workspaceId: wid, deletedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, status: { not: 'done' }, deletedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, status: { not: 'done' }, dueDate: { lt: new Date() }, deletedAt: null } }),
      this.prisma.task.groupBy({ by: ['status'], _count: true, where: { workspaceId: wid, deletedAt: null } }),
    ]);
    return { total, open, overdue, byStatus };
  }
}

@Controller('workspaces/:wid/reports') @UseGuards(WorkspaceGuard)
export class ReportsController {
  constructor(private svc: ReportsService) {}
  @Get('my-stats') async my(@Param('wid') w: string, @CurrentMember() m: any) { return successResponse(await this.svc.personal(w, m.id)); }
  @Get('team') @UseGuards(RolesGuard) @Roles('manager') async team(@Param('wid') w: string, @CurrentMember() m: any) { return successResponse(await this.svc.team(w, m.id)); }
  @Get('workspace') @UseGuards(RolesGuard) @Roles('admin') async ws(@Param('wid') w: string) { return successResponse(await this.svc.workspace(w)); }
}

@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
