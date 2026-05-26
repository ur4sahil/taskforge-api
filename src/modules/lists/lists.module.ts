import { Injectable, NotFoundException, ForbiddenException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsUUID, IsBoolean } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember, Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { generateInboundEmail } from '../../common/utils/slug';

export class CreateListDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name: string = '';
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() defaultAssigneeId?: string;
}

export class UpdateListDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() defaultAssigneeId?: string | null;
  @IsOptional() @IsBoolean() inboundEmailEnabled?: boolean;
}

export class AddListMemberDto {
  @IsUUID() workspaceMemberId: string = '';
}

@Injectable()
export class ListsService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  async create(wid: string, dto: CreateListDto, member: any) {
    const domain = this.config.get<string>('app.inboundEmailDomain') || 'inbound.taskforge.io';
    return this.prisma.list.create({
      data: {
        workspaceId: wid,
        name: dto.name,
        description: dto.description || null,
        defaultAssigneeId: dto.defaultAssigneeId || null,
        inboundEmail: generateInboundEmail(domain),
        createdById: member.id,
        members: { create: { workspaceMemberId: member.id, addedById: member.id } },
      },
      include: { members: { include: { workspaceMember: { include: { user: { select: { name: true, email: true } } } } } } },
    });
  }

  async findAll(wid: string, member: any, page: number, perPage: number) {
    let where: any = { workspaceId: wid, archivedAt: null };
    if (member.role === 'employee') {
      where.members = { some: { workspaceMemberId: member.id } };
    } else if (member.role === 'manager') {
      const rids = (await this.prisma.workspaceMember.findMany({
        where: { managerId: member.id, workspaceId: wid, isActive: true },
        select: { id: true },
      })).map((r: any) => r.id);
      where.OR = [
        { members: { some: { workspaceMemberId: member.id } } },
        { members: { some: { workspaceMemberId: { in: rids } } } },
      ];
    }
    const [lists, total] = await Promise.all([
      this.prisma.list.findMany({
        where,
        include: { _count: { select: { tasks: true, members: true } } },
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.list.count({ where }),
    ]);
    return { lists, meta: paginationMeta(total, page, perPage) };
  }

  async findOne(wid: string, lid: string, member: any) {
    const list = await this.prisma.list.findFirst({
      where: { id: lid, workspaceId: wid },
      include: {
        members: { include: { workspaceMember: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } } } },
        _count: { select: { tasks: true } },
      },
    });
    if (!list) throw new NotFoundException('List not found');
    if (member.role === 'employee' && !list.members.some((lm: any) => lm.workspaceMemberId === member.id)) {
      throw new ForbiddenException('No access');
    }
    return list;
  }

  async update(wid: string, lid: string, dto: UpdateListDto, member: any) {
    await this.assertCanEditSettings(wid, lid, member);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.defaultAssigneeId !== undefined) data.defaultAssigneeId = dto.defaultAssigneeId;
    if (dto.inboundEmailEnabled !== undefined) data.inboundEmailEnabled = dto.inboundEmailEnabled;
    return this.prisma.list.update({ where: { id: lid }, data });
  }

  /** List settings (name, description, default assignee, inbound email) are
   *  manageable by admins, managers (workspace-wide), and the list creator.
   *  Plain employees can use the list but not reconfigure it. */
  private async assertCanEditSettings(wid: string, lid: string, member: any) {
    if (member.role === 'admin' || member.role === 'manager') return;
    const list = await this.prisma.list.findFirst({ where: { id: lid, workspaceId: wid }, select: { createdById: true } });
    if (!list) throw new NotFoundException('List not found');
    if (list.createdById !== member.id) {
      throw new ForbiddenException('Only the list creator, a manager, or an admin can edit list settings');
    }
  }

  async remove(lid: string) {
    await this.prisma.list.delete({ where: { id: lid } });
  }

  async addMember(lid: string, wmid: string, member: any) {
    await this.assertCanManageMembers(lid, member);
    return this.prisma.listMember.upsert({
      where: { listId_workspaceMemberId: { listId: lid, workspaceMemberId: wmid } },
      create: { listId: lid, workspaceMemberId: wmid, addedById: member.id },
      update: {},
    });
  }

  async removeMember(lid: string, mid: string, member: any) {
    await this.assertCanManageMembers(lid, member);
    await this.prisma.listMember.deleteMany({ where: { listId: lid, workspaceMemberId: mid } });
  }

  /** Admin can always manage. Non-admin must be the list creator. */
  private async assertCanManageMembers(lid: string, member: any) {
    if (member.role === 'admin') return;
    const list = await this.prisma.list.findUnique({ where: { id: lid }, select: { createdById: true } });
    if (!list) throw new NotFoundException('List not found');
    if (list.createdById !== member.id) {
      throw new ForbiddenException('Only the list creator or an admin can manage members');
    }
  }
}

@Controller('workspaces/:wid/lists')
@UseGuards(WorkspaceGuard)
export class ListsController {
  constructor(private svc: ListsService) {}

  @Post()
  async create(@Param('wid') wid: string, @Body() dto: CreateListDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.create(wid, dto, m));
  }

  @Get()
  async findAll(@Param('wid') wid: string, @CurrentMember() m: any, @Query() p: PaginationDto) {
    const r = await this.svc.findAll(wid, m, p.page, p.perPage);
    return successResponse(r.lists, r.meta);
  }

  @Get(':lid')
  async findOne(@Param('wid') wid: string, @Param('lid') lid: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.findOne(wid, lid, m));
  }

  @Patch(':lid')
  async update(@Param('wid') wid: string, @Param('lid') lid: string, @Body() dto: UpdateListDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.update(wid, lid, dto, m));
  }

  @Delete(':lid')
  async remove(@Param('lid') lid: string) {
    await this.svc.remove(lid);
    return successResponse({ deleted: true });
  }

  @Post(':lid/members')
  async addMember(@Param('lid') lid: string, @Body() dto: AddListMemberDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.addMember(lid, dto.workspaceMemberId, m));
  }

  @Delete(':lid/members/:mid')
  async removeMember(@Param('lid') lid: string, @Param('mid') mid: string, @CurrentMember() m: any) {
    await this.svc.removeMember(lid, mid, m);
    return successResponse({ removed: true });
  }
}

@Module({
  controllers: [ListsController],
  providers: [ListsService],
  exports: [ListsService],
})
export class ListsModule {}
