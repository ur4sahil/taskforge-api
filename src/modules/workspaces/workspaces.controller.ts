import { Controller, Post, Get, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto, UpdateMemberDto } from './dto';
import { CurrentUser, CurrentMember, Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse, PaginationDto } from '../../common/dto/response.dto';

@Controller('workspaces')
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

  @Patch(':wid/members/:mid')
  @UseGuards(WorkspaceGuard, RolesGuard)
  @Roles('admin')
  async updateMember(@Param('wid') wid: string, @Param('mid') mid: string, @Body() dto: UpdateMemberDto) {
    return successResponse(await this.svc.updateMember(wid, mid, dto));
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
