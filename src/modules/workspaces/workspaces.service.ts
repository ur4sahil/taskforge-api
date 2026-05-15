import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { generateSlug } from '../../common/utils/slug';
import { paginationMeta } from '../../common/dto/response.dto';
import { CreateWorkspaceDto, UpdateWorkspaceDto, UpdateMemberDto, InviteMemberDto } from './dto';

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

  /** Add a member to a workspace. If a user with the given email already exists, link them.
   *  If not, create the user with a generated temporary password and surface it to the
   *  caller — the inviting admin shares it out-of-band. Idempotency: if the user is already
   *  an active member of this workspace, returns 409.
   *
   *  Reactivates a previously-deactivated member instead of creating a duplicate. */
  async inviteMember(wid: string, dto: InviteMemberDto) {
    const email = dto.email.trim().toLowerCase();
    const role = dto.role || 'employee';

    let user = await this.prisma.user.findUnique({ where: { email } });
    let tempPassword: string | null = null;
    if (!user) {
      tempPassword = randomBytes(9).toString('base64').replace(/[/+=]/g, '').slice(0, 12) + '!1';
      user = await this.prisma.user.create({
        data: {
          email,
          name: dto.name,
          passwordHash: await bcrypt.hash(tempPassword, 12),
          authProvider: 'email',
        },
      });
    }

    const existing = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: wid, userId: user.id },
    });
    if (existing) {
      if (existing.isActive) throw new ConflictException('User is already a member of this workspace');
      // Reactivate + update role/manager from the new invite payload.
      const reactivated = await this.prisma.workspaceMember.update({
        where: { id: existing.id },
        data: { isActive: true, role: role as any, managerId: dto.managerId ?? null },
        include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
      });
      return { isNewUser: false, tempPassword: null, member: reactivated };
    }

    const member = await this.prisma.workspaceMember.create({
      data: {
        workspaceId: wid,
        userId: user.id,
        role: role as any,
        managerId: dto.managerId ?? null,
        timezone: 'UTC',
        isActive: true,
      },
      include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
    });
    return { isNewUser: tempPassword !== null, tempPassword, member };
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
