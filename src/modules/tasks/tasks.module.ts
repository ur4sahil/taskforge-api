import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember, Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { getTaskPermissions } from '../../common/utils/permissions';
import { CreateTaskDto, UpdateTaskDto, TaskFilterDto, CreateChecklistItemDto, UpdateChecklistItemDto, ReorderChecklistDto } from './dto';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

const TASK_INCLUDE = {
  creator: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
  assignee: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
  list: { select: { id: true, name: true } },
  checklistItems: { orderBy: { sortOrder: 'asc' as const } },
  _count: { select: { subtasks: true, comments: true, attachments: true, reminders: true } },
};

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async create(wid: string, lid: string, dto: CreateTaskDto, member: any) {
    // The target list must live in this workspace (404 otherwise — never leak
    // existence) and the caller must be able to see it (admins see all lists;
    // managers/employees only lists they have access to, same rule as findAll).
    const list = await this.prisma.list.findFirst({
      where: { id: lid, workspaceId: wid },
      select: { id: true, defaultAssigneeId: true, defaultAssignee: { select: { isActive: true } } },
    });
    if (!list) throw new NotFoundException('List not found');
    if (member.role !== 'admin') {
      const accessible = await this.getAccessibleListIds(wid, member);
      if (!accessible.includes(lid)) throw new ForbiddenException('No access to this list');
    }
    if (dto.parentTaskId) {
      const p = await this.prisma.task.findFirst({ where: { id: dto.parentTaskId, workspaceId: wid, parentTaskId: null } });
      if (!p) throw new BadRequestException('Invalid parent task');
    }
    // Assignee resolution order:
    //   1. explicit dto.assigneeId (the user picked someone)
    //   2. list.defaultAssigneeId (list-level automation rule)
    //   3. the task creator (current fallback)
    // The list default is skipped if its member has been deactivated since
    // the rule was set — otherwise tasks would get auto-assigned to a
    // disabled account and never reach anyone.
    let assigneeId = dto.assigneeId || null;
    if (!assigneeId && list.defaultAssigneeId && list.defaultAssignee?.isActive) assigneeId = list.defaultAssigneeId;
    if (!assigneeId) assigneeId = member.id;
    const task = await this.prisma.task.create({
      data: {
        workspaceId: wid, listId: lid, parentTaskId: dto.parentTaskId || null,
        title: dto.title, description: dto.description || null,
        priority: (dto.priority || 'medium') as any,
        creatorId: member.id, assigneeId,
        source: 'manual' as any,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        startTime: dto.startTime || null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        dueTime: dto.dueTime || null,
        timezone: dto.timezone || member.timezone,
      },
      include: TASK_INCLUDE,
    });
    // Notify assignee if they didn't assign to themselves.
    if (assigneeId !== member.id) this.notifyAssigned(task, member.id).catch(() => {});
    return task;
  }

  /** Helpers for dispatching task-related notifications. Fire-and-forget; never block the
   *  task mutation. */
  private async notifyAssigned(task: any, byMemberId: string) {
    if (!task.assigneeId || task.assigneeId === byMemberId) return;
    const actor = await this.prisma.workspaceMember.findUnique({
      where: { id: byMemberId }, include: { user: { select: { name: true } } },
    });
    const actorName = actor?.user?.name || 'Someone';
    await this.notifications.dispatch({
      workspaceId: task.workspaceId,
      recipientMemberId: task.assigneeId,
      channel: 'task_assigned',
      type: 'task_assigned',
      title: `${actorName} assigned you a task`,
      body: task.title,
      url: `/?task=${task.id}`,
      entityType: 'task',
      entityId: task.id,
      suppressIfActiveScreen: `task:${task.id}`,
      pushTag: `task:${task.id}`,
    });
  }

  private async notifyStatusChanged(task: any, oldStatus: string, byMemberId: string) {
    if (task.status === oldStatus) return;
    const actor = await this.prisma.workspaceMember.findUnique({
      where: { id: byMemberId }, include: { user: { select: { name: true } } },
    });
    const actorName = actor?.user?.name || 'Someone';
    const recipients = new Set<string>();
    if (task.creatorId && task.creatorId !== byMemberId) recipients.add(task.creatorId);
    if (task.assigneeId && task.assigneeId !== byMemberId) recipients.add(task.assigneeId);
    await Promise.all(Array.from(recipients).map(rid => this.notifications.dispatch({
      workspaceId: task.workspaceId,
      recipientMemberId: rid,
      channel: 'task_status',
      type: 'task_status',
      title: `${actorName} moved a task to ${task.status}`,
      body: task.title,
      url: `/?task=${task.id}`,
      entityType: 'task',
      entityId: task.id,
      suppressIfActiveScreen: `task:${task.id}`,
      pushTag: `task:${task.id}`,
    })));
  }

  async findAll(wid: string, member: any, f: TaskFilterDto, page: number, perPage: number) {
    const where: any = { workspaceId: wid, deletedAt: null, parentTaskId: null };
    if (member.role !== 'admin') {
      const ids = await this.getAccessibleListIds(wid, member);
      where.listId = { in: ids };
    }
    if (f.status) where.status = f.status;
    if (f.priority) where.priority = f.priority;
    if (f.assigneeId) where.assigneeId = f.assigneeId;
    const orderBy: any = { [f.sortBy || 'createdAt']: f.sortOrder || 'desc' };
    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({ where, include: TASK_INCLUDE, skip: (page - 1) * perPage, take: perPage, orderBy }),
      this.prisma.task.count({ where }),
    ]);
    return { tasks, meta: paginationMeta(total, page, perPage) };
  }

  async findByList(wid: string, lid: string, f: TaskFilterDto, page: number, perPage: number) {
    const where: any = { workspaceId: wid, listId: lid, deletedAt: null, parentTaskId: null };
    if (f.status) where.status = f.status;
    if (f.priority) where.priority = f.priority;
    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({ where, include: TASK_INCLUDE, skip: (page - 1) * perPage, take: perPage, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.count({ where }),
    ]);
    return { tasks, meta: paginationMeta(total, page, perPage) };
  }

  async findOne(wid: string, tid: string) {
    const t = await this.prisma.task.findFirst({
      where: { id: tid, workspaceId: wid },
      include: { ...TASK_INCLUDE, subtasks: { where: { deletedAt: null }, include: { assignee: { include: { user: { select: { name: true } } } } } }, recurrenceRule: true },
    });
    if (!t) throw new NotFoundException('Task not found');
    return t;
  }

  async update(wid: string, tid: string, dto: UpdateTaskDto, member: any) {
    const task = await this.findOne(wid, tid);
    const perms = this.getPerms(member, task);
    const isStatusOnly = Object.keys(dto).length === 1 && dto.status !== undefined;
    if (isStatusOnly && !perms.canChangeStatus) throw new ForbiddenException('Cannot change status');
    if (!isStatusOnly && !perms.canFullEdit) throw new ForbiddenException('Cannot edit');

    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.assigneeId !== undefined) data.assigneeId = dto.assigneeId;
    if (dto.startDate !== undefined) data.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.dueDate !== undefined) data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status === 'done' && task.status !== 'done') data.completedAt = new Date();
      else if (dto.status !== 'done' && task.status === 'done') data.completedAt = null;
    }
    const updated = await this.prisma.task.update({ where: { id: tid }, data, include: TASK_INCLUDE });

    // Notify on assignee change (reassignment) and status change.
    if (dto.assigneeId !== undefined && dto.assigneeId && dto.assigneeId !== task.assigneeId) {
      this.notifyAssigned(updated, member.id).catch(() => {});
    }
    if (dto.status !== undefined && dto.status !== task.status) {
      this.notifyStatusChanged(updated, task.status, member.id).catch(() => {});
    }
    return { task: updated, oldTask: task };
  }

  async remove(wid: string, tid: string, member: any) {
    const task = await this.findOne(wid, tid);
    if (!this.getPerms(member, task).canDelete) throw new ForbiddenException('Cannot delete');
    await this.prisma.task.updateMany({
      where: { OR: [{ id: tid }, { parentTaskId: tid }], workspaceId: wid },
      data: { deletedAt: new Date() },
    });
  }

  /** Admin-only at the controller (RolesGuard); here we only make sure the task is ours. */
  async lock(wid: string, tid: string, mid: string) {
    await this.findOne(wid, tid);
    return this.prisma.task.update({ where: { id: tid }, data: { isLocked: true, lockedById: mid, lockedAt: new Date() }, include: TASK_INCLUDE });
  }

  async unlock(wid: string, tid: string) {
    await this.findOne(wid, tid);
    return this.prisma.task.update({ where: { id: tid }, data: { isLocked: false, lockedById: null, lockedAt: null }, include: TASK_INCLUDE });
  }

  /** Whoever could delete the task may restore it. findOne does not filter on
   *  deletedAt, so a soft-deleted task is still found here. */
  async restore(wid: string, tid: string, member: any) {
    const task = await this.findOne(wid, tid);
    if (!this.getPerms(member, task).canDelete) throw new ForbiddenException('Cannot restore');
    return this.prisma.task.update({ where: { id: tid }, data: { deletedAt: null }, include: TASK_INCLUDE });
  }

  /** Loads the task (404 if not in this workspace) and enforces the checklist
   *  permission: 'edit' (add / remove / reorder / rename) needs canFullEdit,
   *  'toggle' (isChecked only) needs canToggleChecklist — mirroring how update()
   *  treats a status-only patch vs a full edit. */
  private async assertChecklistAccess(wid: string, tid: string, member: any, kind: 'edit' | 'toggle') {
    const task = await this.findOne(wid, tid);
    const perms = this.getPerms(member, task);
    if (kind === 'edit' && !perms.canFullEdit) throw new ForbiddenException('Cannot edit checklist');
    if (kind === 'toggle' && !perms.canToggleChecklist) throw new ForbiddenException('Cannot toggle checklist');
    return task;
  }

  async addChecklist(wid: string, tid: string, dto: CreateChecklistItemDto, member: any) {
    await this.assertChecklistAccess(wid, tid, member, 'edit');
    const max = await this.prisma.checklistItem.aggregate({ where: { taskId: tid }, _max: { sortOrder: true } });
    return this.prisma.checklistItem.create({ data: { taskId: tid, text: dto.text, sortOrder: (max._max.sortOrder ?? -1) + 1 } });
  }

  async updateChecklist(wid: string, tid: string, cid: string, dto: UpdateChecklistItemDto, member: any) {
    const isToggleOnly = dto.text === undefined && dto.isChecked !== undefined;
    await this.assertChecklistAccess(wid, tid, member, isToggleOnly ? 'toggle' : 'edit');
    const item = await this.prisma.checklistItem.findFirst({ where: { id: cid, taskId: tid } });
    if (!item) throw new NotFoundException('Checklist item not found');
    const data: any = {};
    if (dto.text !== undefined) data.text = dto.text;
    if (dto.isChecked !== undefined) data.isChecked = dto.isChecked;
    return this.prisma.checklistItem.update({ where: { id: cid }, data });
  }

  async deleteChecklist(wid: string, tid: string, cid: string, member: any) {
    await this.assertChecklistAccess(wid, tid, member, 'edit');
    const { count } = await this.prisma.checklistItem.deleteMany({ where: { id: cid, taskId: tid } });
    if (count === 0) throw new NotFoundException('Checklist item not found');
  }

  async reorderChecklist(wid: string, tid: string, dto: ReorderChecklistDto, member: any) {
    await this.assertChecklistAccess(wid, tid, member, 'edit');
    const ids = Array.from(new Set(dto.itemIds));
    const owned = await this.prisma.checklistItem.count({ where: { id: { in: ids }, taskId: tid } });
    if (owned !== ids.length) throw new BadRequestException('itemIds must all belong to this task');
    await this.prisma.$transaction(
      ids.map((id: string, i: number) =>
        this.prisma.checklistItem.updateMany({ where: { id, taskId: tid }, data: { sortOrder: i } })
      )
    );
  }

  private getPerms(member: any, task: any) {
    return getTaskPermissions({
      memberId: member.id,
      memberRole: member.role,
      taskCreatorId: task.creatorId,
      taskCreatorRole: task.creator?.role,
      taskAssigneeId: task.assigneeId,
      taskAssigneeManagerId: task.assignee?.managerId,
      taskIsLocked: task.isLocked,
    });
  }

  private async getAccessibleListIds(wid: string, member: any): Promise<string[]> {
    if (member.role === 'admin') {
      return (await this.prisma.list.findMany({ where: { workspaceId: wid }, select: { id: true } })).map((l: any) => l.id);
    }
    if (member.role === 'manager') {
      const rids = (await this.prisma.workspaceMember.findMany({ where: { managerId: member.id, workspaceId: wid }, select: { id: true } })).map((r: any) => r.id);
      return (await this.prisma.list.findMany({
        where: { workspaceId: wid, OR: [{ members: { some: { workspaceMemberId: member.id } } }, { members: { some: { workspaceMemberId: { in: rids } } } }] },
        select: { id: true },
      })).map((l: any) => l.id);
    }
    return (await this.prisma.listMember.findMany({ where: { workspaceMemberId: member.id }, select: { listId: true } })).map((l: any) => l.listId);
  }
}

@Controller('workspaces/:wid')
@UseGuards(WorkspaceGuard)
export class TasksController {
  constructor(private svc: TasksService) {}

  @Post('lists/:lid/tasks')
  async create(@Param('wid') w: string, @Param('lid') l: string, @Body() d: CreateTaskDto, @CurrentMember() m: any, @Req() r: Request) {
    const t = await this.svc.create(w, l, d, m);
    r.__auditData = { action: 'task.created', entityType: 'task', entityId: t.id, changes: { title: d.title } };
    return successResponse(t);
  }

  @Get('tasks')
  async findAll(@Param('wid') w: string, @CurrentMember() m: any, @Query() f: TaskFilterDto, @Query() p: PaginationDto) {
    const r = await this.svc.findAll(w, m, f, p.page, p.perPage);
    return successResponse(r.tasks, r.meta);
  }

  @Get('lists/:lid/tasks')
  async byList(@Param('wid') w: string, @Param('lid') l: string, @Query() f: TaskFilterDto, @Query() p: PaginationDto) {
    const r = await this.svc.findByList(w, l, f, p.page, p.perPage);
    return successResponse(r.tasks, r.meta);
  }

  @Get('tasks/:tid')
  async findOne(@Param('wid') w: string, @Param('tid') t: string) {
    return successResponse(await this.svc.findOne(w, t));
  }

  @Patch('tasks/:tid')
  async update(@Param('wid') w: string, @Param('tid') t: string, @Body() d: UpdateTaskDto, @CurrentMember() m: any, @Req() r: Request) {
    const res = await this.svc.update(w, t, d, m);
    r.__auditData = { action: 'task.updated', entityType: 'task', entityId: t, changes: d };
    return successResponse(res.task);
  }

  @Delete('tasks/:tid')
  async remove(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: any) {
    await this.svc.remove(w, t, m);
    return successResponse({ deleted: true });
  }

  @Post('tasks/:tid/lock') @UseGuards(RolesGuard) @Roles('admin')
  async lock(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.lock(w, t, m.id));
  }

  @Delete('tasks/:tid/lock') @UseGuards(RolesGuard) @Roles('admin')
  async unlock(@Param('wid') w: string, @Param('tid') t: string) {
    return successResponse(await this.svc.unlock(w, t));
  }

  @Post('tasks/:tid/restore')
  async restore(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.restore(w, t, m));
  }

  @Post('tasks/:tid/checklist')
  async addChecklist(@Param('wid') w: string, @Param('tid') t: string, @Body() d: CreateChecklistItemDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.addChecklist(w, t, d, m));
  }

  // Declare the literal-path /checklist/reorder BEFORE the wildcard /:cid match,
  // otherwise Nest routes it to updateChecklist with cid="reorder" → invalid UUID 500.
  @Patch('tasks/:tid/checklist/reorder')
  async reorder(@Param('wid') w: string, @Param('tid') t: string, @Body() d: ReorderChecklistDto, @CurrentMember() m: any) {
    await this.svc.reorderChecklist(w, t, d, m);
    return successResponse({ ok: true });
  }

  @Patch('tasks/:tid/checklist/:cid')
  async updateChecklist(@Param('wid') w: string, @Param('tid') t: string, @Param('cid') c: string, @Body() d: UpdateChecklistItemDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.updateChecklist(w, t, c, d, m));
  }

  @Delete('tasks/:tid/checklist/:cid')
  async deleteChecklist(@Param('wid') w: string, @Param('tid') t: string, @Param('cid') c: string, @CurrentMember() m: any) {
    await this.svc.deleteChecklist(w, t, c, m);
    return successResponse({ deleted: true });
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
