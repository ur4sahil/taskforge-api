import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { generateSlug } from '../../common/utils/slug';
import { paginationMeta } from '../../common/dto/response.dto';
import { CreateWorkspaceDto, UpdateWorkspaceDto, UpdateMemberDto } from './dto';

@Injectable()
export class WorkspacesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateWorkspaceDto, userId: string) {
    return this.prisma.workspace.create({
      data: {
        name: dto.name,
        slug: generateSlug(dto.name),
        settings: { autoArchiveDays: 30, trashRetentionDays: 30, smartRemindersEnabled: true } as any,
        members: { create: { userId, role: 'admin', timezone: 'UTC' } },
      },
      include: { members: { include: { user: { select: { id: true, email: true, name: true } } } } },
    });
  }

  async findAllForUser(userId: string) {
    const ms = await this.prisma.workspaceMember.findMany({
      where: { userId, isActive: true },
      include: { workspace: true },
    });
    return ms.map((m: any) => ({ ...m.workspace, role: m.role, memberId: m.id }));
  }

  async findOne(wid: string) {
    const w = await this.prisma.workspace.findUnique({ where: { id: wid } });
    if (!w) throw new NotFoundException('Not found');
    return w;
  }

  async update(wid: string, dto: UpdateWorkspaceDto) {
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.settings !== undefined) data.settings = dto.settings;
    return this.prisma.workspace.update({ where: { id: wid }, data });
  }

  async getMembers(wid: string, page: number, perPage: number) {
    const [members, total] = await Promise.all([
      this.prisma.workspaceMember.findMany({
        where: { workspaceId: wid },
        include: {
          user: { select: { id: true, email: true, name: true, avatarUrl: true } },
          manager: { include: { user: { select: { name: true } } } },
        },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.workspaceMember.count({ where: { workspaceId: wid } }),
    ]);
    return { members, meta: paginationMeta(total, page, perPage) };
  }

  async updateMember(wid: string, mid: string, dto: UpdateMemberDto) {
    const m = await this.prisma.workspaceMember.findFirst({ where: { id: mid, workspaceId: wid } });
    if (!m) throw new NotFoundException('Member not found');
    const data: any = {};
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.managerId !== undefined) data.managerId = dto.managerId;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    return this.prisma.workspaceMember.update({
      where: { id: mid },
      data,
      include: { user: { select: { id: true, email: true, name: true } } },
    });
  }

  async deactivateMember(wid: string, mid: string) {
    const open = await this.prisma.task.count({
      where: { workspaceId: wid, assigneeId: mid, status: { not: 'done' }, deletedAt: null },
    });
    if (open > 0) throw new BadRequestException(`${open} open tasks — reassign first`);
    return this.prisma.workspaceMember.update({ where: { id: mid }, data: { isActive: false } });
  }

  async reactivateMember(wid: string, mid: string) {
    return this.prisma.workspaceMember.update({ where: { id: mid }, data: { isActive: true } });
  }
}
