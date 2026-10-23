import {
  Injectable, NotFoundException, ConflictException, BadRequestException,
  Module, Controller, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';
import { workspaceTimezone, dateKeyToDb, dbDateToKey, todayKey } from '../../common/utils/dates';
import { computeNextFromRule, RecurrenceSpec, DayKey } from '../../common/utils/recurrence';
import { CreateRecurrenceDto, UpdateRecurrenceDto } from './dto';
export { CreateRecurrenceDto, UpdateRecurrenceDto } from './dto';

/** The schedule anchor: the source task's dueDate day, else its createdAt day
 *  in the rule's timezone. The anchor is occurrence #1 (the source task). */
export function anchorFor(task: { dueDate: Date | null; createdAt: Date }, tz: string): DayKey {
  return task.dueDate ? dbDateToKey(task.dueDate) : todayKey(tz, task.createdAt);
}

/** Build the pure-engine spec from a stored rule + its source task. */
export function specFromRule(
  rule: {
    frequency: string; interval: number; daysOfWeek: number[]; dayOfMonth: number | null;
    endType: string; endCount: number | null; endDate: Date | null; timezone: string;
    repeatAfterCompletion: boolean; repeatDelayValue: number | null; repeatDelayUnit: string | null;
  },
  task: { dueDate: Date | null; createdAt: Date },
  generatedCount = 0,
): RecurrenceSpec {
  return {
    frequency: rule.frequency,
    interval: rule.interval,
    daysOfWeek: rule.daysOfWeek,
    dayOfMonth: rule.dayOfMonth,
    endType: rule.endType,
    endCount: rule.endCount,
    endDate: rule.endDate,
    repeatAfterCompletion: rule.repeatAfterCompletion,
    repeatDelayValue: rule.repeatDelayValue,
    repeatDelayUnit: rule.repeatDelayUnit,
    anchor: anchorFor(task, ruleTimezone(rule.timezone)),
    generatedCount,
  };
}

/** A stored rule timezone, falling back to the workspace default if it is not
 *  a real IANA zone (older rows may hold 'UTC' or garbage). */
export function ruleTimezone(tz: string | null | undefined): string {
  return workspaceTimezone({ timezone: tz });
}

@Injectable()
export class RecurrenceService {
  constructor(private prisma: PrismaService) {}

  private async loadTask(wid: string, tid: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: tid, workspaceId: wid, deletedAt: null },
      include: { workspace: { select: { settings: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  /** nextOccurrence as stored (midnight UTC of the calendar day) or null. A
   *  schedule-based rule that can never fire again is a client error. */
  private nextFor(data: Parameters<typeof specFromRule>[0], task: { dueDate: Date | null; createdAt: Date; completedAt: Date | null }, generatedCount: number) {
    const tz = ruleTimezone(data.timezone);
    const completedOn = task.completedAt ? todayKey(tz, task.completedAt) : null;
    const next = computeNextFromRule(specFromRule(data, task, generatedCount), new Date(), tz, completedOn);
    if (!next && !data.repeatAfterCompletion) throw new BadRequestException('Rule produces no future occurrences');
    return next ? dateKeyToDb(next) : null;
  }

  async create(wid: string, tid: string, dto: CreateRecurrenceDto) {
    const task = await this.loadTask(wid, tid);
    const existing = await this.prisma.recurrenceRule.findUnique({ where: { taskId: tid } });
    // An active rule already covers this task. A deactivated one (DELETE sets
    // isActive=false) is replaced in place so the user can re-enable recurrence.
    if (existing?.isActive) throw new ConflictException('Task already has a recurrence rule');

    const data = {
      frequency: dto.frequency as any,
      interval: dto.interval ?? 1,
      daysOfWeek: dto.daysOfWeek ?? [],
      dayOfMonth: dto.dayOfMonth ?? null,
      endType: (dto.endType ?? 'never') as any,
      endCount: dto.endType === 'after_count' ? dto.endCount ?? null : null,
      endDate: dto.endType === 'on_date' && dto.endDate ? dateKeyToDb(dto.endDate) : null,
      timezone: dto.timezone ?? workspaceTimezone(task.workspace.settings),
      repeatAfterCompletion: dto.repeatAfterCompletion ?? false,
      repeatDelayValue: dto.repeatDelayValue ?? null,
      repeatDelayUnit: dto.repeatDelayUnit ?? null,
    };
    const nextOccurrence = this.nextFor(data, task, 0);
    const payload = { ...data, nextOccurrence, isActive: true, lastGenerated: null as Date | null };
    if (existing) return this.prisma.recurrenceRule.update({ where: { id: existing.id }, data: payload });
    return this.prisma.recurrenceRule.create({ data: { taskId: tid, workspaceId: wid, ...payload } });
  }

  /** Partial update; nextOccurrence is recomputed from the merged rule. */
  async update(wid: string, tid: string, dto: UpdateRecurrenceDto) {
    const r = await this.prisma.recurrenceRule.findFirst({ where: { taskId: tid, workspaceId: wid } });
    if (!r) throw new NotFoundException('Not found');
    const task = await this.loadTask(wid, tid);

    const merged = {
      frequency: dto.frequency ?? r.frequency,
      interval: dto.interval ?? r.interval,
      daysOfWeek: dto.daysOfWeek ?? r.daysOfWeek,
      dayOfMonth: dto.dayOfMonth !== undefined ? dto.dayOfMonth : r.dayOfMonth,
      endType: dto.endType ?? r.endType,
      endCount: dto.endCount !== undefined ? dto.endCount : r.endCount,
      endDate: dto.endDate !== undefined ? (dto.endDate ? dateKeyToDb(dto.endDate) : null) : r.endDate,
      timezone: dto.timezone ?? r.timezone,
      repeatAfterCompletion: dto.repeatAfterCompletion ?? r.repeatAfterCompletion,
      repeatDelayValue: dto.repeatDelayValue !== undefined ? dto.repeatDelayValue : r.repeatDelayValue,
      repeatDelayUnit: dto.repeatDelayUnit !== undefined ? dto.repeatDelayUnit : r.repeatDelayUnit,
    };
    if (merged.endType === 'after_count' && !merged.endCount) throw new BadRequestException('endCount is required when endType is after_count');
    if (merged.endType === 'on_date' && !merged.endDate) throw new BadRequestException('endDate is required when endType is on_date');
    if (merged.endType !== 'after_count') merged.endCount = null;
    if (merged.endType !== 'on_date') merged.endDate = null;

    const generated = await this.prisma.taskInstance.count({ where: { recurrenceRuleId: r.id } });
    const nextOccurrence = this.nextFor(merged as any, task, generated);
    return this.prisma.recurrenceRule.update({
      where: { id: r.id },
      data: { ...(merged as any), nextOccurrence, isActive: dto.isActive ?? r.isActive },
    });
  }

  async remove(wid: string, tid: string) {
    const r = await this.prisma.recurrenceRule.findFirst({ where: { taskId: tid, workspaceId: wid } });
    if (!r) throw new NotFoundException('Not found');
    await this.prisma.recurrenceRule.update({ where: { id: r.id }, data: { isActive: false } });
  }
}

@Controller('workspaces/:wid/tasks/:tid/recurrence') @UseGuards(WorkspaceGuard)
export class RecurrenceController {
  constructor(private svc: RecurrenceService) {}
  @Post() async create(@Param('wid') w: string, @Param('tid') t: string, @Body() d: CreateRecurrenceDto) { return successResponse(await this.svc.create(w, t, d)); }
  @Patch() async update(@Param('wid') w: string, @Param('tid') t: string, @Body() d: UpdateRecurrenceDto) { return successResponse(await this.svc.update(w, t, d)); }
  @Delete() async remove(@Param('wid') w: string, @Param('tid') t: string) { await this.svc.remove(w, t); return successResponse({ deleted: true }); }
}

@Module({ controllers: [RecurrenceController], providers: [RecurrenceService], exports: [RecurrenceService] })
export class RecurrenceModule {}
