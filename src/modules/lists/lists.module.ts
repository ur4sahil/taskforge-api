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

  async update(wid: string, lid: string, dto: UpdateListDto) {
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.defaultAssigneeId !== undefined) data.defaultAssigneeId = dto.defaultAssigneeId;
    if (dto.inboundEmailEnabled !== undefined) data.inboundEmailEnabled = dto.inboundEmailEnabled;
    return this.prisma.list.update({ where: { id: lid }, data });
  }

  async remove(lid: string) {
    await this.prisma.list.delete({ where: { id: lid } });
  }

  async addMember(lid: string, wmid: string, addedBy: string) {
    return this.prisma.listMember.upsert({
      where: { listId_workspaceMemberId: { listId: lid, workspaceMemberId: wmid } },
      create: { listId: lid, workspaceMemberId: wmid, addedById: addedBy },
      update: {},
    });
  }

  async removeMember(lid: string, mid: string) {
    await this.prisma.listMember.deleteMany({ where: { listId: lid, workspaceMemberId: mid } });
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
  async update(@Param('wid') wid: string, @Param('lid') lid: string, @Body() dto: UpdateListDto) {
    return successResponse(await this.svc.update(wid, lid, dto));
  }

  @Delete(':lid')
  async remove(@Param('lid') lid: string) {
    await this.svc.remove(lid);
    return successResponse({ deleted: true });
  }

  @Post(':lid/members')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async addMember(@Param('lid') lid: string, @Body() dto: AddListMemberDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.addMember(lid, dto.workspaceMemberId, m.id));
  }

  @Delete(':lid/members/:mid')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async removeMember(@Param('lid') lid: string, @Param('mid') mid: string) {
    await this.svc.removeMember(lid, mid);
    return successResponse({ removed: true });
  }
}

@Module({
  controllers: [ListsController],
  providers: [ListsService],
  exports: [ListsService],
})
export class ListsModule {}
