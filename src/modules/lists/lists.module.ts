import { Injectable, NotFoundException, ForbiddenException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, Roles, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard, RolesGuard } from '@/common/guards';
import { successResponse, PaginationDto, paginationMeta } from '@/common/dto/response.dto';
import { generateInboundEmail } from '@/common/utils/slug';
import { CreateListDto, UpdateListDto, AddListMemberDto } from './dto';

@Injectable()
export class ListsService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}
  async create(wid: string, dto: CreateListDto, m: CurrentWorkspaceMember) {
    const domain = this.config.get<string>('app.inboundEmailDomain') || 'inbound.taskforge.io';
    return this.prisma.list.create({ data: { workspaceId: wid, name: dto.name, description: dto.description || null, defaultAssigneeId: dto.defaultAssigneeId || null, inboundEmail: generateInboundEmail(domain), createdById: m.id, members: { create: { workspaceMemberId: m.id, addedById: m.id } } }, include: { members: { include: { workspaceMember: { include: { user: { select: { name: true, email: true } } } } } } } });
  }
  async findAll(wid: string, m: CurrentWorkspaceMember, p: PaginationDto) {
    let where: any = { workspaceId: wid, archivedAt: null };
    if (m.role === 'employee') where.members = { some: { workspaceMemberId: m.id } };
    else if (m.role === 'manager') {
      const rids = (await this.prisma.workspaceMember.findMany({ where: { managerId: m.id, workspaceId: wid, isActive: true }, select: { id: true } })).map(r => r.id);
      where.OR = [{ members: { some: { workspaceMemberId: m.id } } }, { members: { some: { workspaceMemberId: { in: rids } } } }];
    }
    const [lists, total] = await Promise.all([this.prisma.list.findMany({ where, include: { _count: { select: { tasks: true, members: true } } }, skip: (p.page-1)*p.perPage, take: p.perPage, orderBy: { createdAt: 'desc' } }), this.prisma.list.count({ where })]);
    return { lists, meta: paginationMeta(total, p.page, p.perPage) };
  }
  async findOne(wid: string, lid: string, m: CurrentWorkspaceMember) {
    const list = await this.prisma.list.findFirst({ where: { id: lid, workspaceId: wid }, include: { members: { include: { workspaceMember: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } } } }, _count: { select: { tasks: true } } } });
    if (!list) throw new NotFoundException('List not found');
    if (m.role === 'employee' && !list.members.some(lm => lm.workspaceMemberId === m.id)) throw new ForbiddenException('No access');
    return list;
  }
  async update(wid: string, lid: string, dto: UpdateListDto) { return this.prisma.list.update({ where: { id: lid }, data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), ...(dto.defaultAssigneeId !== undefined ? { defaultAssigneeId: dto.defaultAssigneeId } : {}), ...(dto.inboundEmailEnabled !== undefined ? { inboundEmailEnabled: dto.inboundEmailEnabled } : {}) } }); }
  async delete(wid: string, lid: string) { await this.prisma.list.delete({ where: { id: lid } }); }
  async addMember(wid: string, lid: string, wmid: string, addedBy: string) { return this.prisma.listMember.upsert({ where: { listId_workspaceMemberId: { listId: lid, workspaceMemberId: wmid } }, create: { listId: lid, workspaceMemberId: wmid, addedById: addedBy }, update: {} }); }
  async removeMember(lid: string, mid: string) { await this.prisma.listMember.deleteMany({ where: { listId: lid, workspaceMemberId: mid } }); }
}

@Controller('workspaces/:wid/lists') @UseGuards(WorkspaceGuard)
export class ListsController {
  constructor(private svc: ListsService) {}
  @Post() async create(@Param('wid') wid: string, @Body() dto: CreateListDto, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.create(wid, dto, m)); }
  @Get() async findAll(@Param('wid') wid: string, @CurrentMember() m: CurrentWorkspaceMember, @Query() p: PaginationDto) { const r = await this.svc.findAll(wid, m, p); return successResponse(r.lists, r.meta); }
  @Get(':lid') async findOne(@Param('wid') wid: string, @Param('lid') lid: string, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.findOne(wid, lid, m)); }
  @Patch(':lid') async update(@Param('wid') wid: string, @Param('lid') lid: string, @Body() dto: UpdateListDto) { return successResponse(await this.svc.update(wid, lid, dto)); }
  @Delete(':lid') async remove(@Param('wid') wid: string, @Param('lid') lid: string) { await this.svc.delete(wid, lid); return successResponse({ deleted: true }); }
  @Post(':lid/members') @UseGuards(RolesGuard) @Roles('admin') async addMember(@Param('wid') wid: string, @Param('lid') lid: string, @Body() dto: AddListMemberDto, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.addMember(wid, lid, dto.workspaceMemberId, m.id)); }
  @Delete(':lid/members/:mid') @UseGuards(RolesGuard) @Roles('admin') async removeMember(@Param('lid') lid: string, @Param('mid') mid: string) { await this.svc.removeMember(lid, mid); return successResponse({ removed: true }); }
}

@Module({ controllers: [ListsController], providers: [ListsService], exports: [ListsService] })
export class ListsModule {}
