import { Injectable, NotFoundException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsEnum, IsObject } from 'class-validator';
import { TemplateType, TemplateVisibility } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard } from '@/common/guards';
import { successResponse, PaginationDto, paginationMeta } from '@/common/dto/response.dto';
export class CreateTemplateDto { @IsEnum(TemplateType) type: TemplateType = 'task'; @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; @IsOptional() @IsString() description?: string; @IsOptional() @IsEnum(TemplateVisibility) visibility?: TemplateVisibility; @IsObject() data: Record<string,unknown> = {}; }
@Injectable() export class TemplatesService {
  constructor(private prisma: PrismaService) {}
  async create(wid: string, d: CreateTemplateDto, mid: string) { return this.prisma.template.create({ data: { workspaceId: wid, type: d.type, name: d.name, description: d.description??null, createdById: mid, visibility: d.visibility??'personal', data: d.data, version: 1, versionHistory: [] } }); }
  async findAll(wid: string, mid: string, p: PaginationDto) { const w = { workspaceId: wid, OR: [{ visibility: 'workspace' as const }, { createdById: mid }] }; const [t, n] = await Promise.all([this.prisma.template.findMany({ where: w, skip: (p.page-1)*p.perPage, take: p.perPage, orderBy: { updatedAt: 'desc' } }), this.prisma.template.count({ where: w })]); return { templates: t, meta: paginationMeta(n, p.page, p.perPage) }; }
  async findOne(wid: string, tid: string) { const t = await this.prisma.template.findFirst({ where: { id: tid, workspaceId: wid } }); if (!t) throw new NotFoundException('Not found'); return t; }
  async update(wid: string, tid: string, d: Partial<CreateTemplateDto>, mid: string) { const t = await this.findOne(wid, tid); const h = (t.versionHistory as any[])||[]; h.unshift({ version: t.version, data: t.data, updatedAt: t.updatedAt }); return this.prisma.template.update({ where: { id: tid }, data: { ...(d.name?{name:d.name}:{}), ...(d.data?{data:d.data}:{}), ...(d.visibility?{visibility:d.visibility}:{}), version: t.version+1, versionHistory: h.slice(0,5) } }); }
  async delete(wid: string, tid: string) { await this.findOne(wid, tid); await this.prisma.template.delete({ where: { id: tid } }); }
  async duplicate(wid: string, tid: string, mid: string) { const t = await this.findOne(wid, tid); return this.prisma.template.create({ data: { workspaceId: wid, type: t.type, name: `${t.name} (Copy)`, description: t.description, createdById: mid, visibility: 'personal', data: t.data, version: 1, versionHistory: [] } }); }
  async getVersions(wid: string, tid: string) { const t = await this.findOne(wid, tid); return t.versionHistory; }
}
@Controller('workspaces/:wid/templates') @UseGuards(WorkspaceGuard) export class TemplatesController {
  constructor(private svc: TemplatesService) {}
  @Post() async create(@Param('wid') w: string, @Body() d: CreateTemplateDto, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.create(w, d, m.id)); }
  @Get() async findAll(@Param('wid') w: string, @CurrentMember() m: CurrentWorkspaceMember, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p); return successResponse(r.templates, r.meta); }
  @Get(':tid') async findOne(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.findOne(w, t)); }
  @Patch(':tid') async update(@Param('wid') w: string, @Param('tid') t: string, @Body() d: Partial<CreateTemplateDto>, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.update(w, t, d, m.id)); }
  @Delete(':tid') async remove(@Param('wid') w: string, @Param('tid') t: string) { await this.svc.delete(w, t); return successResponse({ deleted: true }); }
  @Post(':tid/duplicate') async dup(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.duplicate(w, t, m.id)); }
  @Get(':tid/versions') async versions(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.getVersions(w, t)); }
}
@Module({ controllers: [TemplatesController], providers: [TemplatesService], exports: [TemplatesService] }) export class TemplatesModule {}
