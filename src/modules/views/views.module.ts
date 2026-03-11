import { Injectable, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsEnum, IsObject } from 'class-validator';
import { ViewType, ViewVisibility } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard } from '@/common/guards';
import { successResponse, PaginationDto, paginationMeta } from '@/common/dto/response.dto';
export class CreateViewDto { @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; @IsEnum(ViewType) type: ViewType = 'list'; @IsOptional() @IsObject() filters?: Record<string,unknown>; @IsOptional() @IsObject() sort?: Record<string,unknown>; @IsOptional() @IsString() groupBy?: string; @IsOptional() @IsEnum(ViewVisibility) visibility?: ViewVisibility; }
@Injectable() export class ViewsService {
  constructor(private prisma: PrismaService) {}
  async create(wid: string, d: CreateViewDto, mid: string) { return this.prisma.savedView.create({ data: { workspaceId: wid, createdById: mid, name: d.name, type: d.type, filters: d.filters??{}, sort: d.sort??{}, groupBy: d.groupBy??null, visibility: d.visibility??'personal' } }); }
  async findAll(wid: string, mid: string, p: PaginationDto) { const w = { workspaceId: wid, OR: [{ visibility: 'shared' as const }, { createdById: mid }] }; const [v, n] = await Promise.all([this.prisma.savedView.findMany({ where: w, skip: (p.page-1)*p.perPage, take: p.perPage }), this.prisma.savedView.count({ where: w })]); return { views: v, meta: paginationMeta(n, p.page, p.perPage) }; }
  async update(vid: string, d: Partial<CreateViewDto>) { return this.prisma.savedView.update({ where: { id: vid }, data: d as any }); }
  async delete(vid: string) { await this.prisma.savedView.delete({ where: { id: vid } }); }
}
@Controller('workspaces/:wid/views') @UseGuards(WorkspaceGuard) export class ViewsController {
  constructor(private svc: ViewsService) {}
  @Post() async create(@Param('wid') w: string, @Body() d: CreateViewDto, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.create(w, d, m.id)); }
  @Get() async findAll(@Param('wid') w: string, @CurrentMember() m: CurrentWorkspaceMember, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p); return successResponse(r.views, r.meta); }
  @Patch(':vid') async update(@Param('vid') v: string, @Body() d: Partial<CreateViewDto>) { return successResponse(await this.svc.update(v, d)); }
  @Delete(':vid') async remove(@Param('vid') v: string) { await this.svc.delete(v); return successResponse({ deleted: true }); }
}
@Module({ controllers: [ViewsController], providers: [ViewsService], exports: [ViewsService] }) export class ViewsModule {}
