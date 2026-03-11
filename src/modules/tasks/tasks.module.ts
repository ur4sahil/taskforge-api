import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards, UseInterceptors, Req } from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, Roles, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard, RolesGuard } from '@/common/guards';
import { AuditLogInterceptor } from '@/common/interceptors/audit-log.interceptor';
import { successResponse, PaginationDto, paginationMeta } from '@/common/dto/response.dto';
import { getTaskPermissions, TaskPermCtx } from '@/common/utils/permissions';
import { CreateTaskDto, UpdateTaskDto, TaskFilterDto, BatchActionDto, CreateChecklistItemDto, UpdateChecklistItemDto, ReorderChecklistDto } from './dto';

const INCLUDE = { creator: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, assignee: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, list: { select: { id: true, name: true } }, checklistItems: { orderBy: { sortOrder: 'asc' as const } }, _count: { select: { subtasks: true, comments: true, attachments: true, reminders: true } } };

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  async create(wid: string, lid: string, dto: CreateTaskDto, m: CurrentWorkspaceMember) {
    if (dto.parentTaskId) { const p = await this.prisma.task.findFirst({ where: { id: dto.parentTaskId, workspaceId: wid, parentTaskId: null } }); if (!p) throw new BadRequestException('Invalid parent task'); }
    return this.prisma.task.create({ data: { workspaceId: wid, listId: lid, parentTaskId: dto.parentTaskId || null, title: dto.title, description: dto.description || null, priority: dto.priority || 'medium', creatorId: m.id, assigneeId: dto.assigneeId || null, source: 'manual', startDate: dto.startDate ? new Date(dto.startDate) : null, startTime: dto.startTime || null, dueDate: dto.dueDate ? new Date(dto.dueDate) : null, dueTime: dto.dueTime || null, timezone: dto.timezone || m.timezone }, include: INCLUDE });
  }

  async findAll(wid: string, m: CurrentWorkspaceMember, f: TaskFilterDto, p: PaginationDto) {
    const where: any = { workspaceId: wid, deletedAt: null, parentTaskId: null };
    if (m.role !== 'admin') { const ids = await this.getListIds(wid, m); where.listId = { in: ids }; }
    if (f.status) where.status = f.status; if (f.priority) where.priority = f.priority; if (f.assigneeId) where.assigneeId = f.assigneeId;
    const [tasks, total] = await Promise.all([this.prisma.task.findMany({ where, include: INCLUDE, skip: (p.page-1)*p.perPage, take: p.perPage, orderBy: { [f.sortBy || 'createdAt']: f.sortOrder || 'desc' } }), this.prisma.task.count({ where })]);
    return { tasks, meta: paginationMeta(total, p.page, p.perPage) };
  }

  async findByList(wid: string, lid: string, f: TaskFilterDto, p: PaginationDto) {
    const where: any = { workspaceId: wid, listId: lid, deletedAt: null, parentTaskId: null };
    if (f.status) where.status = f.status; if (f.priority) where.priority = f.priority;
    const [tasks, total] = await Promise.all([this.prisma.task.findMany({ where, include: INCLUDE, skip: (p.page-1)*p.perPage, take: p.perPage, orderBy: { createdAt: 'desc' } }), this.prisma.task.count({ where })]);
    return { tasks, meta: paginationMeta(total, p.page, p.perPage) };
  }

  async findOne(wid: string, tid: string) {
    const t = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid }, include: { ...INCLUDE, subtasks: { where: { deletedAt: null }, include: { assignee: { include: { user: { select: { name: true } } } } } }, recurrenceRule: true } });
    if (!t) throw new NotFoundException('Task not found'); return t;
  }

  async update(wid: string, tid: string, dto: UpdateTaskDto, m: CurrentWorkspaceMember) {
    const task = await this.findOne(wid, tid);
    const perms = this.getPerms(m, task);
    const isStatusOnly = Object.keys(dto).length === 1 && dto.status !== undefined;
    if (isStatusOnly && !perms.canChangeStatus) throw new ForbiddenException('Cannot change status');
    if (!isStatusOnly && !perms.canFullEdit) throw new ForbiddenException('Cannot edit');
    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title; if (dto.description !== undefined) data.description = dto.description;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.assigneeId !== undefined) data.assigneeId = dto.assigneeId;
    if (dto.startDate !== undefined) data.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.dueDate !== undefined) data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.status !== undefined) { data.status = dto.status; if (dto.status === 'done' && task.status !== 'done') data.completedAt = new Date(); else if (dto.status !== 'done' && task.status === 'done') data.completedAt = null; }
    return { task: await this.prisma.task.update({ where: { id: tid }, data, include: INCLUDE }), oldTask: task };
  }

  async delete(wid: string, tid: string, m: CurrentWorkspaceMember) {
    const task = await this.findOne(wid, tid);
    if (!this.getPerms(m, task).canDelete) throw new ForbiddenException('Cannot delete');
    await this.prisma.task.updateMany({ where: { OR: [{ id: tid }, { parentTaskId: tid }], workspaceId: wid }, data: { deletedAt: new Date() } });
  }

  async lock(wid: string, tid: string, mid: string) { return this.prisma.task.update({ where: { id: tid }, data: { isLocked: true, lockedById: mid, lockedAt: new Date() }, include: INCLUDE }); }
  async unlock(wid: string, tid: string) { return this.prisma.task.update({ where: { id: tid }, data: { isLocked: false, lockedById: null, lockedAt: null }, include: INCLUDE }); }
  async restore(wid: string, tid: string) { return this.prisma.task.update({ where: { id: tid }, data: { deletedAt: null }, include: INCLUDE }); }

  async addChecklist(tid: string, dto: CreateChecklistItemDto) { const max = await this.prisma.checklistItem.aggregate({ where: { taskId: tid }, _max: { sortOrder: true } }); return this.prisma.checklistItem.create({ data: { taskId: tid, text: dto.text, sortOrder: (max._max.sortOrder ?? -1) + 1 } }); }
  async updateChecklist(cid: string, dto: UpdateChecklistItemDto) { return this.prisma.checklistItem.update({ where: { id: cid }, data: { ...(dto.text !== undefined ? { text: dto.text } : {}), ...(dto.isChecked !== undefined ? { isChecked: dto.isChecked } : {}) } }); }
  async deleteChecklist(cid: string) { await this.prisma.checklistItem.delete({ where: { id: cid } }); }
  async reorderChecklist(tid: string, dto: ReorderChecklistDto) { await this.prisma.$transaction(dto.itemIds.map((id, i) => this.prisma.checklistItem.update({ where: { id }, data: { sortOrder: i } }))); }

  private getPerms(m: CurrentWorkspaceMember, t: any) {
    return getTaskPermissions({ memberId: m.id, memberRole: m.role, taskCreatorId: t.creatorId || t.creator?.id, taskCreatorRole: t.creator?.role || t.creator?.user?.role, taskAssigneeId: t.assigneeId, taskAssigneeManagerId: t.assignee?.managerId, taskIsLocked: t.isLocked });
  }
  private async getListIds(wid: string, m: CurrentWorkspaceMember) {
    if (m.role === 'admin') return (await this.prisma.list.findMany({ where: { workspaceId: wid }, select: { id: true } })).map(l => l.id);
    if (m.role === 'manager') { const rids = (await this.prisma.workspaceMember.findMany({ where: { managerId: m.id, workspaceId: wid }, select: { id: true } })).map(r => r.id); return (await this.prisma.list.findMany({ where: { workspaceId: wid, OR: [{ members: { some: { workspaceMemberId: m.id } } }, { members: { some: { workspaceMemberId: { in: rids } } } }] }, select: { id: true } })).map(l => l.id); }
    return (await this.prisma.listMember.findMany({ where: { workspaceMemberId: m.id }, select: { listId: true } })).map(l => l.listId);
  }
}

@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard) @UseInterceptors(AuditLogInterceptor)
export class TasksController {
  constructor(private svc: TasksService) {}
  @Post('lists/:lid/tasks') async create(@Param('wid') w: string, @Param('lid') l: string, @Body() d: CreateTaskDto, @CurrentMember() m: CurrentWorkspaceMember, @Req() r: Request) { const t = await this.svc.create(w, l, d, m); r.__auditData = { action: 'task.created', entityType: 'task', entityId: t.id, changes: { title: d.title } }; return successResponse(t); }
  @Get('tasks') async findAll(@Param('wid') w: string, @CurrentMember() m: CurrentWorkspaceMember, @Query() f: TaskFilterDto, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m, f, p); return successResponse(r.tasks, r.meta); }
  @Get('lists/:lid/tasks') async byList(@Param('wid') w: string, @Param('lid') l: string, @Query() f: TaskFilterDto, @Query() p: PaginationDto) { const r = await this.svc.findByList(w, l, f, p); return successResponse(r.tasks, r.meta); }
  @Get('tasks/:tid') async findOne(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.findOne(w, t)); }
  @Patch('tasks/:tid') async update(@Param('wid') w: string, @Param('tid') t: string, @Body() d: UpdateTaskDto, @CurrentMember() m: CurrentWorkspaceMember, @Req() r: Request) { const res = await this.svc.update(w, t, d, m); r.__auditData = { action: 'task.updated', entityType: 'task', entityId: t, changes: d as any }; return successResponse(res.task); }
  @Delete('tasks/:tid') async delete(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: CurrentWorkspaceMember) { await this.svc.delete(w, t, m); return successResponse({ deleted: true }); }
  @Post('tasks/:tid/lock') @UseGuards(RolesGuard) @Roles('admin') async lock(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.lock(w, t, m.id)); }
  @Delete('tasks/:tid/lock') @UseGuards(RolesGuard) @Roles('admin') async unlock(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.unlock(w, t)); }
  @Post('tasks/:tid/restore') async restore(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.restore(w, t)); }
  @Post('tasks/:tid/checklist') async addChecklist(@Param('tid') t: string, @Body() d: CreateChecklistItemDto) { return successResponse(await this.svc.addChecklist(t, d)); }
  @Patch('tasks/:tid/checklist/:cid') async updateChecklist(@Param('cid') c: string, @Body() d: UpdateChecklistItemDto) { return successResponse(await this.svc.updateChecklist(c, d)); }
  @Delete('tasks/:tid/checklist/:cid') async deleteChecklist(@Param('cid') c: string) { await this.svc.deleteChecklist(c); return successResponse({ deleted: true }); }
  @Patch('tasks/:tid/checklist/reorder') async reorder(@Param('tid') t: string, @Body() d: ReorderChecklistDto) { await this.svc.reorderChecklist(t, d); return successResponse({ ok: true }); }
  @Get('tasks/:tid/subtasks') async subtasks(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.findOne(w, t).then(t => (t as any).subtasks)); }
}

@Module({ controllers: [TasksController], providers: [TasksService], exports: [TasksService] })
export class TasksModule {}
