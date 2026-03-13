import { Injectable, NotFoundException, Module, Controller, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { IsString, IsInt, IsOptional, IsArray, IsDateString, IsBoolean, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';

export class CreateRecurrenceDto { @IsString() frequency: string = 'weekly'; @IsOptional() @IsInt() @Min(1) interval?: number; @IsOptional() @IsArray() daysOfWeek?: number[]; @IsOptional() @IsInt() dayOfMonth?: number; @IsOptional() @IsString() endType?: string; @IsOptional() @IsInt() endCount?: number; @IsOptional() @IsDateString() endDate?: string; @IsOptional() @IsString() timezone?: string; @IsOptional() @IsBoolean() repeatAfterCompletion?: boolean; }

@Injectable()
export class RecurrenceService {
  constructor(private prisma: PrismaService) {}
  async create(wid: string, tid: string, dto: CreateRecurrenceDto, tz: string) {
    const task = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid } });
    if (!task) throw new NotFoundException('Task not found');
    const next = new Date(task.dueDate || new Date());
    const iv = dto.interval ?? 1;
    switch (dto.frequency) { case 'daily': next.setDate(next.getDate() + iv); break; case 'weekly': next.setDate(next.getDate() + 7 * iv); break; case 'monthly': next.setMonth(next.getMonth() + iv); break; case 'yearly': next.setFullYear(next.getFullYear() + iv); break; default: next.setDate(next.getDate() + iv); }
    return this.prisma.recurrenceRule.create({ data: { taskId: tid, workspaceId: wid, frequency: dto.frequency as any, interval: iv, daysOfWeek: dto.daysOfWeek ?? [], dayOfMonth: dto.dayOfMonth ?? null, endType: (dto.endType ?? 'never') as any, endCount: dto.endCount ?? null, endDate: dto.endDate ? new Date(dto.endDate) : null, timezone: dto.timezone ?? tz, repeatAfterCompletion: dto.repeatAfterCompletion ?? false, nextOccurrence: next, isActive: true } });
  }
  async update(wid: string, tid: string, dto: any) { const r = await this.prisma.recurrenceRule.findFirst({ where: { taskId: tid, workspaceId: wid } }); if (!r) throw new NotFoundException('Not found'); const data: any = {}; if (dto.frequency) data.frequency = dto.frequency; if (dto.interval) data.interval = dto.interval; return this.prisma.recurrenceRule.update({ where: { id: r.id }, data }); }
  async remove(wid: string, tid: string) { const r = await this.prisma.recurrenceRule.findFirst({ where: { taskId: tid, workspaceId: wid } }); if (!r) throw new NotFoundException('Not found'); await this.prisma.recurrenceRule.update({ where: { id: r.id }, data: { isActive: false } }); }
}

@Controller('workspaces/:wid/tasks/:tid/recurrence') @UseGuards(WorkspaceGuard)
export class RecurrenceController {
  constructor(private svc: RecurrenceService) {}
  @Post() async create(@Param('wid') w: string, @Param('tid') t: string, @Body() d: CreateRecurrenceDto, @CurrentMember() m: any) { return successResponse(await this.svc.create(w, t, d, m.timezone)); }
  @Patch() async update(@Param('wid') w: string, @Param('tid') t: string, @Body() d: any) { return successResponse(await this.svc.update(w, t, d)); }
  @Delete() async remove(@Param('wid') w: string, @Param('tid') t: string) { await this.svc.remove(w, t); return successResponse({ deleted: true }); }
}

@Module({ controllers: [RecurrenceController], providers: [RecurrenceService], exports: [RecurrenceService] })
export class RecurrenceModule {}
