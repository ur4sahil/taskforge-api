import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { generateSlug } from '../../common/utils/slug';
import { paginationMeta } from '../../common/dto/response.dto';
import { CreateWorkspaceDto, UpdateWorkspaceDto, UpdateMemberDto } from './dto';

@Injectable()
export class WorkspacesService {
  constructor(
    private prisma: PrismaService,
  ) {}

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
    if (dto.managerId !== undefined) {
      // A manager must be an active member of THIS workspace and not the member
      // themself. null clears the manager.
      if (dto.managerId !== null) {
        if (dto.managerId === mid) throw new BadRequestException('A member cannot be their own manager');
        const mgr = await this.prisma.workspaceMember.findFirst({
          where: { id: dto.managerId, workspaceId: wid, isActive: true },
          select: { id: true },
        });
        if (!mgr) throw new BadRequestException('managerId must be an active member of this workspace');
      }
      data.managerId = dto.managerId;
    }
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    return this.prisma.workspaceMember.update({
      where: { id: mid },
      data,
      include: { user: { select: { id: true, email: true, name: true } } },
    });
  }

  /** Admin-initiated password rotation. Useful when an invited user lost
   *  their temp password OR a member needs a hard reset. Generates a new
   *  random temp password, hashes it, stores it on the User row, and
   *  surfaces the plaintext to the admin so they can share out-of-band.
   *
   *  Refuses to rotate for OAuth-only accounts (no passwordHash to begin
   *  with — they sign in via Google). */
  async rotatePassword(wid: string, mid: string): Promise<{ tempPassword: string; email: string }> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { id: mid, workspaceId: wid },
      include: { user: { select: { id: true, email: true, authProvider: true } } },
    });
    if (!member) throw new NotFoundException('Member not found');
    if (member.user.authProvider !== 'email') {
      throw new BadRequestException('Cannot rotate password for non-email accounts (e.g. Google sign-in)');
    }
    const tempPassword = randomBytes(9).toString('base64').replace(/[/+=]/g, '').slice(0, 12) + '!1';
    await this.prisma.user.update({
      where: { id: member.user.id },
      data: { passwordHash: await bcrypt.hash(tempPassword, 12) },
    });
    // Invalidate any active refresh tokens — forces the affected user to log
    // in fresh, otherwise an already-signed-in session keeps working.
    await this.prisma.refreshToken.updateMany({
      where: { userId: member.user.id, isRevoked: false },
      data: { isRevoked: true },
    });
    return { tempPassword, email: member.user.email };
  }

  /** 404 unless `mid` is a member row of workspace `wid`. */
  private async assertMemberInWorkspace(wid: string, mid: string) {
    const m = await this.prisma.workspaceMember.findFirst({ where: { id: mid, workspaceId: wid }, select: { id: true } });
    if (!m) throw new NotFoundException('Member not found');
  }

  async deactivateMember(wid: string, mid: string) {
    await this.assertMemberInWorkspace(wid, mid);
    const open = await this.prisma.task.count({
      where: { workspaceId: wid, assigneeId: mid, status: { not: 'done' }, deletedAt: null },
    });
    if (open > 0) throw new BadRequestException(`${open} open tasks — reassign first`);
    return this.prisma.workspaceMember.update({ where: { id: mid }, data: { isActive: false } });
  }

  async reactivateMember(wid: string, mid: string) {
    await this.assertMemberInWorkspace(wid, mid);
    return this.prisma.workspaceMember.update({ where: { id: mid }, data: { isActive: true } });
  }
}
