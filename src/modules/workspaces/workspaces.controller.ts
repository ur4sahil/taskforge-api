import { Controller, Post, Get, Patch, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto, UpdateMemberDto, InviteMemberDto } from './dto';
import { CurrentUser, CurrentMember, Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse, PaginationDto } from '../../common/dto/response.dto';

@Controller('workspaces')
// Member mutations (invite/role/deactivate/reactivate) are admin-only and
// JWT-gated. The global 100/min default throttler was honest-user-bursting
// (e.g. an admin onboarding a team). Bypass it here — the role guard is the
// real protection.
@SkipThrottle()
export class WorkspacesController {
  constructor(private svc: WorkspacesService) {}

  @Post()
  async create(@Body() dto: CreateWorkspaceDto, @CurrentUser() u: any) {
    return successResponse(await this.svc.create(dto, u.userId));
  }

  @Get()
  async findAll(@CurrentUser() u: any) {
    return successResponse(await this.svc.findAllForUser(u.userId));
  }

  @Get(':wid')
  @UseGuards(WorkspaceGuard)
  async findOne(@Param('wid') wid: string) {
    return successResponse(await this.svc.findOne(wid));
  }

  @Patch(':wid')
  @UseGuards(WorkspaceGuard, RolesGuard)
  @Roles('admin')
  async update(@Param('wid') wid: string, @Body() dto: UpdateWorkspaceDto) {
    return successResponse(await this.svc.update(wid, dto));
  }

  @Get(':wid/members')
  @UseGuards(WorkspaceGuard)
  async members(@Param('wid') wid: string, @Query() p: PaginationDto) {
    const r = await this.svc.getMembers(wid, p.page, p.perPage);
    return successResponse(r.members, r.meta);
  }

  @Post(':wid/members')
  @UseGuards(WorkspaceGuard, RolesGuard)
  @Roles('admin')
  async inviteMember(@Param('wid') wid: string, @Body() dto: InviteMemberDto, @CurrentMember() actor: any, @Req() req: Request) {
    const result = await this.svc.inviteMember(wid, dto, actor.id);
    (req as any).__auditData = {
      action: 'member.invited',
      entityType: 'workspaceMember',
      entityId: result.member.id,
      changes: { email: result.member.user?.email, role: result.member.role, isNewUser: result.isNewUser },
    };
    return successResponse(result);
  }

  @Patch(':wid/members/:mid')
  @UseGuards(WorkspaceGuard, RolesGuard)
  @Roles('admin')
  async updateMember(@Param('wid') wid: string, @Param('mid') mid: string, @Body() dto: UpdateMemberDto) {
    return successResponse(await this.svc.updateMember(wid, mid, dto));
  }

  @Post(':wid/members/:mid/rotate-password')
  @UseGuards(WorkspaceGuard, RolesGuard)
  @Roles('admin')
  async rotatePassword(@Param('wid') wid: string, @Param('mid') mid: string, @Req() req: Request) {
    const out = await this.svc.rotatePassword(wid, mid);
    (req as any).__auditData = {
      action: 'member.password-rotated',
      entityType: 'workspaceMember',
      entityId: mid,
      changes: { email: out.email },
    };
    return successResponse(out);
  }

  @Post(':wid/members/:mid/deactivate')
  @UseGuards(WorkspaceGuard, RolesGuard)
  @Roles('admin')
  async deactivate(@Param('wid') wid: string, @Param('mid') mid: string) {
    return successResponse(await this.svc.deactivateMember(wid, mid));
  }

  @Post(':wid/members/:mid/reactivate')
  @UseGuards(WorkspaceGuard, RolesGuard)
  @Roles('admin')
  async reactivate(@Param('wid') wid: string, @Param('mid') mid: string) {
    return successResponse(await this.svc.reactivateMember(wid, mid));
  }
}
