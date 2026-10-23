import { Injectable, NotFoundException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsOptional, IsDateString, IsInt } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';

export class CreateReminderDto { @IsString() type: string = 'exact'; @IsOptional() @IsDateString() exactTime?: string; @IsOptional() @IsInt() relativeOffsetValue?: number; @IsOptional() @IsString() relativeOffsetUnit?: string; }
export class SnoozeDto { @IsOptional() @IsDateString() until?: string; @IsOptional() @IsString() duration?: string; }

@Injectable()
export class RemindersService {
  constructor(private prisma: PrismaService) {}
  /** 404 unless the task lives in this workspace. */
  private async assertTaskInWorkspace(wid: string, tid: string) {
    const t = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid }, select: { id: true } });
    if (!t) throw new NotFoundException('Task not found');
  }
  /** Reminders are personal: a non-admin may only touch reminders they own. The
   *  owner predicate is folded into the lookup so a non-owner gets the same 404
   *  as a non-existent id (no existence leak). Admins can manage any reminder in
   *  their workspace. Always scoped through the reminder's task → workspaceId. */
  private async findOwned(wid: string, rid: string, member: any) {
    const r = await this.prisma.reminder.findFirst({
      where: { id: rid, task: { workspaceId: wid }, ...(member.role === 'admin' ? {} : { workspaceMemberId: member.id }) },
      select: { id: true },
    });
    if (!r) throw new NotFoundException('Reminder not found');
    return r;
  }
  async create(wid: string, tid: string, dto: CreateReminderDto, mid: string) {
    await this.assertTaskInWorkspace(wid, tid);
    const nft = dto.exactTime ? new Date(dto.exactTime) : null;
    return this.prisma.reminder.create({ data: { taskId: tid, workspaceMemberId: mid, type: dto.type as any, exactTime: dto.exactTime ? new Date(dto.exactTime) : null, relativeOffsetValue: dto.relativeOffsetValue ?? null, relativeOffsetUnit: dto.relativeOffsetUnit ?? null, nextFireTime: nft } });
  }
  async findByTask(wid: string, tid: string, member: any) {
    await this.assertTaskInWorkspace(wid, tid);
    return this.prisma.reminder.findMany({
      where: { taskId: tid, ...(member.role === 'admin' ? {} : { workspaceMemberId: member.id }) },
      orderBy: { nextFireTime: 'asc' },
    });
  }
  async getUpcoming(mid: string, hours: number) { return this.prisma.reminder.findMany({ where: { workspaceMemberId: mid, isFired: false, isDismissed: false, nextFireTime: { lte: new Date(Date.now() + hours * 3600000) } }, include: { task: { select: { id: true, title: true, status: true, dueDate: true } } }, orderBy: { nextFireTime: 'asc' } }); }
  async getCalendar(mid: string, start: string, end: string) { return this.prisma.reminder.findMany({ where: { workspaceMemberId: mid, isFired: false, isDismissed: false, nextFireTime: { gte: new Date(start), lte: new Date(end) } }, include: { task: { select: { id: true, title: true } } } }); }
  async getSuggestions(mid: string) { return this.prisma.reminder.findMany({ where: { workspaceMemberId: mid, isSmartSuggestion: true, isDismissed: false, isFired: false }, include: { task: { select: { id: true, title: true, dueDate: true } } } }); }
  async update(wid: string, rid: string, dto: any, member: any) { await this.findOwned(wid, rid, member); const data: any = {}; if (dto.exactTime) { data.exactTime = new Date(dto.exactTime); data.nextFireTime = new Date(dto.exactTime); } return this.prisma.reminder.update({ where: { id: rid }, data }); }
  async remove(wid: string, rid: string, member: any) { await this.findOwned(wid, rid, member); await this.prisma.reminder.delete({ where: { id: rid } }); }
  async snooze(wid: string, rid: string, dto: SnoozeDto, member: any) { await this.findOwned(wid, rid, member); const until = dto.until ? new Date(dto.until) : new Date(Date.now() + 3600000); return this.prisma.reminder.update({ where: { id: rid }, data: { snoozedUntil: until, nextFireTime: until } }); }
  async dismiss(wid: string, rid: string, member: any) { await this.findOwned(wid, rid, member); return this.prisma.reminder.update({ where: { id: rid }, data: { isDismissed: true } }); }
}

@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard)
export class RemindersController {
  constructor(private svc: RemindersService) {}
  @Post('tasks/:tid/reminders') async create(@Param('wid') w: string, @Param('tid') t: string, @Body() d: CreateReminderDto, @CurrentMember() m: any) { return successResponse(await this.svc.create(w, t, d, m.id)); }
  @Get('tasks/:tid/reminders') async byTask(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: any) { return successResponse(await this.svc.findByTask(w, t, m)); }
  @Get('reminders/upcoming') async upcoming(@CurrentMember() m: any, @Query('hours') h?: string) { return successResponse(await this.svc.getUpcoming(m.id, h ? parseInt(h) : 48)); }
  @Get('reminders/calendar') async calendar(@CurrentMember() m: any, @Query('start') s: string, @Query('end') e: string) { return successResponse(await this.svc.getCalendar(m.id, s, e)); }
  @Get('reminders/suggestions') async suggestions(@CurrentMember() m: any) { return successResponse(await this.svc.getSuggestions(m.id)); }
  @Patch('reminders/:rid') async update(@Param('wid') w: string, @Param('rid') r: string, @Body() d: any, @CurrentMember() m: any) { return successResponse(await this.svc.update(w, r, d, m)); }
  @Delete('reminders/:rid') async remove(@Param('wid') w: string, @Param('rid') r: string, @CurrentMember() m: any) { await this.svc.remove(w, r, m); return successResponse({ deleted: true }); }
  @Post('reminders/:rid/snooze') async snooze(@Param('wid') w: string, @Param('rid') r: string, @Body() d: SnoozeDto, @CurrentMember() m: any) { return successResponse(await this.svc.snooze(w, r, d, m)); }
  @Post('reminders/:rid/dismiss') async dismiss(@Param('wid') w: string, @Param('rid') r: string, @CurrentMember() m: any) { return successResponse(await this.svc.dismiss(w, r, m)); }
}

@Module({ controllers: [RemindersController], providers: [RemindersService], exports: [RemindersService] })
export class RemindersModule {}
