import {
  Injectable, NotFoundException, BadRequestException,
  Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';
import { workspaceTimezone, dbDateToKey } from '../../common/utils/dates';
import { localDateTimeToUtc, subtractOffset } from '../../common/utils/recurrence';
import { CreateReminderDto, UpdateReminderDto, SnoozeDto } from './dto';
export { CreateReminderDto, UpdateReminderDto, SnoozeDto } from './dto';

/** Wall-clock time a task is due when it has no dueTime. */
export const DEFAULT_DUE_TIME = '09:00';

/**
 * Fire instant of a relative reminder: the task's due instant (dueDate +
 * dueTime, default 09:00, in the workspace timezone) minus the offset. Null
 * when the task has no due date — nothing to be relative to.
 */
export function relativeFireTime(
  task: { dueDate: Date | null; dueTime: string | null },
  offsetValue: number | null | undefined,
  offsetUnit: string | null | undefined,
  tz: string,
): Date | null {
  if (!task.dueDate) return null;
  const due = localDateTimeToUtc(dbDateToKey(task.dueDate), task.dueTime || DEFAULT_DUE_TIME, tz);
  return subtractOffset(due, offsetValue ?? 0, offsetUnit ?? 'minutes');
}

@Injectable()
export class RemindersService {
  constructor(private prisma: PrismaService) {}
  /** 404 unless the task lives in this workspace. */
  private async loadTask(wid: string, tid: string) {
    const t = await this.prisma.task.findFirst({
      where: { id: tid, workspaceId: wid },
      select: { id: true, dueDate: true, dueTime: true, workspace: { select: { settings: true } } },
    });
    if (!t) throw new NotFoundException('Task not found');
    return t;
  }
  /** Reminders are personal: a non-admin may only touch reminders they own. The
   *  owner predicate is folded into the lookup so a non-owner gets the same 404
   *  as a non-existent id (no existence leak). Admins can manage any reminder in
   *  their workspace. Always scoped through the reminder's task → workspaceId. */
  private async findOwned(wid: string, rid: string, member: any) {
    const r = await this.prisma.reminder.findFirst({
      where: { id: rid, task: { workspaceId: wid }, ...(member.role === 'admin' ? {} : { workspaceMemberId: member.id }) },
      select: { id: true, type: true, relativeOffsetValue: true, relativeOffsetUnit: true, task: { select: { dueDate: true, dueTime: true, workspace: { select: { settings: true } } } } },
    });
    if (!r) throw new NotFoundException('Reminder not found');
    return r;
  }
  async create(wid: string, tid: string, dto: CreateReminderDto, mid: string) {
    const task = await this.loadTask(wid, tid);
    if (dto.type === 'recurring') throw new BadRequestException('Recurring reminders are not supported yet');
    let nextFireTime: Date | null = null;
    if (dto.type === 'exact') {
      nextFireTime = new Date(dto.exactTime!);
    } else {
      if (!task.dueDate) throw new BadRequestException('Task has no due date to be relative to');
      nextFireTime = relativeFireTime(task, dto.relativeOffsetValue, dto.relativeOffsetUnit, workspaceTimezone(task.workspace.settings));
    }
    return this.prisma.reminder.create({
      data: {
        taskId: tid, workspaceMemberId: mid, type: dto.type as any,
        exactTime: dto.type === 'exact' ? new Date(dto.exactTime!) : null,
        relativeOffsetValue: dto.type === 'relative' ? dto.relativeOffsetValue ?? 0 : null,
        relativeOffsetUnit: dto.type === 'relative' ? dto.relativeOffsetUnit ?? 'minutes' : null,
        nextFireTime,
      },
    });
  }
  /**
   * Re-anchor every pending relative reminder on `taskId` after its dueDate or
   * dueTime changed. Fired or dismissed reminders are left alone (a reminder
   * fires once); an active snooze is cleared because it was relative to the old
   * due instant. Clears nextFireTime when the due date was removed. Returns the
   * number of reminders touched.
   */
  async recomputeForTask(taskId: string): Promise<number> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { dueDate: true, dueTime: true, workspace: { select: { settings: true } } },
    });
    if (!task) return 0;
    const tz = workspaceTimezone(task.workspace.settings);
    const pending = await this.prisma.reminder.findMany({
      where: { taskId, type: 'relative', isFired: false, isDismissed: false },
      select: { id: true, relativeOffsetValue: true, relativeOffsetUnit: true },
    });
    for (const r of pending) {
      const nextFireTime = relativeFireTime(task, r.relativeOffsetValue, r.relativeOffsetUnit, tz);
      await this.prisma.reminder.update({ where: { id: r.id }, data: { nextFireTime, snoozedUntil: null } });
    }
    return pending.length;
  }
  async findByTask(wid: string, tid: string, member: any) {
    await this.loadTask(wid, tid);
    return this.prisma.reminder.findMany({
      where: { taskId: tid, ...(member.role === 'admin' ? {} : { workspaceMemberId: member.id }) },
      orderBy: { nextFireTime: 'asc' },
    });
  }
  async getUpcoming(mid: string, hours: number) { return this.prisma.reminder.findMany({ where: { workspaceMemberId: mid, isFired: false, isDismissed: false, nextFireTime: { lte: new Date(Date.now() + hours * 3600000) } }, include: { task: { select: { id: true, title: true, status: true, dueDate: true } } }, orderBy: { nextFireTime: 'asc' } }); }
  async getCalendar(mid: string, start: string, end: string) { return this.prisma.reminder.findMany({ where: { workspaceMemberId: mid, isFired: false, isDismissed: false, nextFireTime: { gte: new Date(start), lte: new Date(end) } }, include: { task: { select: { id: true, title: true } } } }); }
  async getSuggestions(mid: string) { return this.prisma.reminder.findMany({ where: { workspaceMemberId: mid, isSmartSuggestion: true, isDismissed: false, isFired: false }, include: { task: { select: { id: true, title: true, dueDate: true } } } }); }
  async update(wid: string, rid: string, dto: UpdateReminderDto, member: any) {
    const r = await this.findOwned(wid, rid, member);
    const data: any = {};
    if (r.type === 'exact' && dto.exactTime) { data.exactTime = new Date(dto.exactTime); data.nextFireTime = data.exactTime; data.snoozedUntil = null; }
    if (r.type === 'relative' && (dto.relativeOffsetValue !== undefined || dto.relativeOffsetUnit !== undefined)) {
      data.relativeOffsetValue = dto.relativeOffsetValue ?? r.relativeOffsetValue;
      data.relativeOffsetUnit = dto.relativeOffsetUnit ?? r.relativeOffsetUnit;
      data.nextFireTime = relativeFireTime(r.task, data.relativeOffsetValue, data.relativeOffsetUnit, workspaceTimezone(r.task.workspace.settings));
      data.snoozedUntil = null;
    }
    return this.prisma.reminder.update({ where: { id: rid }, data });
  }
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
  @Patch('reminders/:rid') async update(@Param('wid') w: string, @Param('rid') r: string, @Body() d: UpdateReminderDto, @CurrentMember() m: any) { return successResponse(await this.svc.update(w, r, d, m)); }
  @Delete('reminders/:rid') async remove(@Param('wid') w: string, @Param('rid') r: string, @CurrentMember() m: any) { await this.svc.remove(w, r, m); return successResponse({ deleted: true }); }
  @Post('reminders/:rid/snooze') async snooze(@Param('wid') w: string, @Param('rid') r: string, @Body() d: SnoozeDto, @CurrentMember() m: any) { return successResponse(await this.svc.snooze(w, r, d, m)); }
  @Post('reminders/:rid/dismiss') async dismiss(@Param('wid') w: string, @Param('rid') r: string, @CurrentMember() m: any) { return successResponse(await this.svc.dismiss(w, r, m)); }
}

@Module({ controllers: [RemindersController], providers: [RemindersService], exports: [RemindersService] })
export class RemindersModule {}
