import { Injectable, NotFoundException, BadRequestException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsObject } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { generateInboundEmail } from '../../common/utils/slug';

export class CreateTemplateDto { @IsString() type: string = 'task'; @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; @IsOptional() @IsString() description?: string; @IsOptional() @IsString() visibility?: string; @IsOptional() @IsObject() data?: any; }
export class SaveAsTemplateDto { @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; @IsOptional() @IsString() visibility?: string; }
export class InstantiateListDto { @IsOptional() @IsString() @MaxLength(255) name?: string; }

/** Shape of `data` for type='task' templates. */
interface TaskTemplateData {
  title: string;
  description?: string | null;
  priority?: string;
  status?: string;
  defaultAssigneeMemberId?: string | null;
  dueDateOffsetDays?: number | null;
  startDateOffsetDays?: number | null;
  checklistItems?: { text: string; sortOrder: number }[];
}

/** Shape of `data` for type='list' templates. */
interface ListTemplateData {
  listName: string;
  listDescription?: string | null;
  defaultAssigneeMemberId?: string | null;
  tasks: TaskTemplateData[];
}

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  async create(wid: string, d: CreateTemplateDto, mid: string) {
    return this.prisma.template.create({
      data: { workspaceId: wid, type: d.type as any, name: d.name, description: d.description ?? null, createdById: mid, visibility: (d.visibility ?? 'personal') as any, data: (d.data ?? {}) as any, version: 1, versionHistory: [] as any },
    });
  }

  async findAll(wid: string, mid: string, page: number, perPage: number) {
    const where: any = { workspaceId: wid, OR: [{ visibility: 'workspace' }, { createdById: mid }] };
    const [templates, total] = await Promise.all([
      this.prisma.template.findMany({ where, skip: (page - 1) * perPage, take: perPage, orderBy: { updatedAt: 'desc' } }),
      this.prisma.template.count({ where }),
    ]);
    return { templates, meta: paginationMeta(total, page, perPage) };
  }

  async findOne(wid: string, tid: string) {
    const t = await this.prisma.template.findFirst({ where: { id: tid, workspaceId: wid } });
    if (!t) throw new NotFoundException('Not found');
    return t;
  }

  async update(wid: string, tid: string, d: any, mid: string) {
    const t = await this.findOne(wid, tid);
    const h = (t.versionHistory as any[]) || [];
    h.unshift({ version: t.version, data: t.data, updatedAt: t.updatedAt });
    const data: any = { version: t.version + 1, versionHistory: h.slice(0, 5) as any };
    if (d.name) data.name = d.name;
    if (d.data) data.data = d.data as any;
    if (d.visibility) data.visibility = d.visibility;
    return this.prisma.template.update({ where: { id: tid }, data });
  }

  async remove(wid: string, tid: string) { await this.findOne(wid, tid); await this.prisma.template.delete({ where: { id: tid } }); }

  async duplicate(wid: string, tid: string, mid: string) {
    const t = await this.findOne(wid, tid);
    return this.prisma.template.create({
      data: { workspaceId: wid, type: t.type, name: `${t.name} (Copy)`, description: t.description, createdById: mid, visibility: 'personal' as any, data: t.data as any, version: 1, versionHistory: [] as any },
    });
  }

  async getVersions(wid: string, tid: string) { const t = await this.findOne(wid, tid); return t.versionHistory; }

  /* ---------- Save-as-template (snapshot existing entities) ---------- */

  /** Capture a task as a reusable task template. Dates become relative offsets. */
  async saveTaskAsTemplate(wid: string, tid: string, member: any, name: string, visibility: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: tid, workspaceId: wid, deletedAt: null },
      include: { checklistItems: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!task) throw new NotFoundException('Task not found');
    const data = this.snapshotTask(task);
    return this.prisma.template.create({
      data: {
        workspaceId: wid, type: 'task', name,
        description: null,
        createdById: member.id, visibility: (visibility ?? 'personal') as any,
        data: data as any, version: 1, versionHistory: [] as any,
      },
    });
  }

  /** Capture a list (and its non-deleted top-level tasks) as a reusable list template. */
  async saveListAsTemplate(wid: string, lid: string, member: any, name: string, visibility: string) {
    const list = await this.prisma.list.findFirst({
      where: { id: lid, workspaceId: wid, archivedAt: null },
      include: {
        tasks: {
          where: { deletedAt: null, parentTaskId: null },
          include: { checklistItems: { orderBy: { sortOrder: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!list) throw new NotFoundException('List not found');
    const data: ListTemplateData = {
      listName: list.name,
      listDescription: list.description,
      defaultAssigneeMemberId: list.defaultAssigneeId,
      tasks: list.tasks.map((t: any) => this.snapshotTask(t)),
    };
    return this.prisma.template.create({
      data: {
        workspaceId: wid, type: 'list', name,
        description: null,
        createdById: member.id, visibility: (visibility ?? 'personal') as any,
        data: data as any, version: 1, versionHistory: [] as any,
      },
    });
  }

  /* ---------- Apply (instantiate from template) ---------- */

  /** Create a new task in `listId` from a task template. */
  async applyTaskTemplate(wid: string, templateId: string, listId: string, member: any) {
    const tmpl = await this.findOne(wid, templateId);
    if (tmpl.type !== 'task') throw new BadRequestException('Template is not a task template');
    const list = await this.prisma.list.findFirst({ where: { id: listId, workspaceId: wid, archivedAt: null } });
    if (!list) throw new NotFoundException('Target list not found');
    return this.instantiateTask(wid, listId, tmpl.data as any, member);
  }

  /** Create a new list (with optional name override) from a list template, plus all its tasks. */
  async instantiateListTemplate(wid: string, templateId: string, member: any, overrideName?: string) {
    const tmpl = await this.findOne(wid, templateId);
    if (tmpl.type !== 'list') throw new BadRequestException('Template is not a list template');
    const data = tmpl.data as any as ListTemplateData;
    const domain = this.config.get<string>('app.inboundEmailDomain') || 'inbound.taskforge.io';
    const list = await this.prisma.list.create({
      data: {
        workspaceId: wid,
        name: overrideName?.trim() || data.listName,
        description: data.listDescription ?? null,
        defaultAssigneeId: data.defaultAssigneeMemberId ?? null,
        inboundEmail: generateInboundEmail(domain),
        createdById: member.id,
        members: { create: { workspaceMemberId: member.id, addedById: member.id } },
      },
    });
    for (const td of data.tasks || []) {
      await this.instantiateTask(wid, list.id, td, member);
    }
    return list;
  }

  /* ---------- Snapshot / instantiate helpers ---------- */

  private snapshotTask(task: any): TaskTemplateData {
    const now = Date.now();
    const day = 86400000;
    return {
      title: task.title,
      description: task.description ?? null,
      priority: task.priority,
      status: task.status,
      defaultAssigneeMemberId: task.assigneeId ?? null,
      dueDateOffsetDays: task.dueDate ? Math.ceil((new Date(task.dueDate).getTime() - now) / day) : null,
      startDateOffsetDays: task.startDate ? Math.ceil((new Date(task.startDate).getTime() - now) / day) : null,
      checklistItems: (task.checklistItems || []).map((c: any) => ({ text: c.text, sortOrder: c.sortOrder })),
    };
  }

  private async instantiateTask(wid: string, listId: string, data: TaskTemplateData, member: any) {
    const now = Date.now();
    const day = 86400000;
    const dueDate = data.dueDateOffsetDays != null ? new Date(now + data.dueDateOffsetDays * day) : null;
    const startDate = data.startDateOffsetDays != null ? new Date(now + data.startDateOffsetDays * day) : null;
    const newTask = await this.prisma.task.create({
      data: {
        workspaceId: wid,
        listId,
        creatorId: member.id,
        assigneeId: data.defaultAssigneeMemberId ?? member.id,
        title: data.title,
        description: data.description ?? null,
        priority: (data.priority || 'medium') as any,
        status: 'todo' as any,  // apply always lands in "todo" — the template's status was just historical
        dueDate,
        startDate,
        source: 'template' as any,
        timezone: member.timezone,
      },
    });
    if (data.checklistItems && data.checklistItems.length > 0) {
      await this.prisma.checklistItem.createMany({
        data: data.checklistItems.map((c, i) => ({
          taskId: newTask.id, text: c.text, sortOrder: c.sortOrder ?? i, isChecked: false,
        })),
      });
    }
    return newTask;
  }
}

@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard)
export class TemplatesController {
  constructor(private svc: TemplatesService) {}

  @Post('templates') async create(@Param('wid') w: string, @Body() d: CreateTemplateDto, @CurrentMember() m: any) { return successResponse(await this.svc.create(w, d, m.id)); }
  @Get('templates') async findAll(@Param('wid') w: string, @CurrentMember() m: any, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p.page, p.perPage); return successResponse(r.templates, r.meta); }
  @Get('templates/:tid') async findOne(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.findOne(w, t)); }
  @Patch('templates/:tid') async update(@Param('wid') w: string, @Param('tid') t: string, @Body() d: any, @CurrentMember() m: any) { return successResponse(await this.svc.update(w, t, d, m.id)); }
  @Delete('templates/:tid') async remove(@Param('wid') w: string, @Param('tid') t: string) { await this.svc.remove(w, t); return successResponse({ deleted: true }); }
  @Post('templates/:tid/duplicate') async dup(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: any) { return successResponse(await this.svc.duplicate(w, t, m.id)); }
  @Get('templates/:tid/versions') async versions(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.getVersions(w, t)); }

  // Snapshot existing entity → new template
  @Post('tasks/:tid/save-as-template')
  async saveTask(@Param('wid') w: string, @Param('tid') t: string, @Body() d: SaveAsTemplateDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.saveTaskAsTemplate(w, t, m, d.name, d.visibility ?? 'personal'));
  }
  @Post('lists/:lid/save-as-template')
  async saveList(@Param('wid') w: string, @Param('lid') l: string, @Body() d: SaveAsTemplateDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.saveListAsTemplate(w, l, m, d.name, d.visibility ?? 'personal'));
  }

  // Apply / instantiate
  @Post('templates/:tid/apply-to-list/:lid')
  async applyTask(@Param('wid') w: string, @Param('tid') t: string, @Param('lid') l: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.applyTaskTemplate(w, t, l, m));
  }
  @Post('templates/:tid/instantiate-list')
  async applyList(@Param('wid') w: string, @Param('tid') t: string, @Body() d: InstantiateListDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.instantiateListTemplate(w, t, m, d.name));
  }
}

@Module({ controllers: [TemplatesController], providers: [TemplatesService], exports: [TemplatesService] })
export class TemplatesModule {}
