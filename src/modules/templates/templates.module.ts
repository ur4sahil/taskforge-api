import { Injectable, NotFoundException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsObject } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';

export class CreateTemplateDto { @IsString() type: string = 'task'; @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; @IsOptional() @IsString() description?: string; @IsOptional() @IsString() visibility?: string; @IsOptional() @IsObject() data?: any; }

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  async create(wid: string, d: CreateTemplateDto, mid: string) {
    return this.prisma.template.create({
      data: { workspaceId: wid, type: d.type as any, name: d.name, description: d.description ?? null, createdById: mid, visibility: (d.visibility ?? 'personal') as any, data: (d.data ?? {}) as any, version: 1, versionHistory: [] as any },
    });
  }

  async findAll(wid: string, mid: string, page: number, perPage: number) {
    const where: any = { workspaceId: wid, OR: [{ visibility: 'workspace' }, { createdById: mid }] };
    const [templates, total] = await Promise.all([
      this.prisma.template.findMany({ where, skip: (page - 1) * perPage, take: perPage, orderBy: { updatedAt: 'desc' } }),
      this.prisma.template.count({ where }),
    ]);
    return { templates, meta: paginationMeta(total, page, perPage) };
  }

  async findOne(wid: string, tid: string) {
    const t = await this.prisma.template.findFirst({ where: { id: tid, workspaceId: wid } });
    if (!t) throw new NotFoundException('Not found');
    return t;
  }

  async update(wid: string, tid: string, d: any, mid: string) {
    const t = await this.findOne(wid, tid);
    const h = (t.versionHistory as any[]) || [];
    h.unshift({ version: t.version, data: t.data, updatedAt: t.updatedAt });
    const data: any = { version: t.version + 1, versionHistory: h.slice(0, 5) as any };
    if (d.name) data.name = d.name;
    if (d.data) data.data = d.data as any;
    if (d.visibility) data.visibility = d.visibility;
    return this.prisma.template.update({ where: { id: tid }, data });
  }

  async remove(wid: string, tid: string) { await this.findOne(wid, tid); await this.prisma.template.delete({ where: { id: tid } }); }

  async duplicate(wid: string, tid: string, mid: string) {
    const t = await this.findOne(wid, tid);
    return this.prisma.template.create({
      data: { workspaceId: wid, type: t.type, name: `${t.name} (Copy)`, description: t.description, createdById: mid, visibility: 'personal' as any, data: t.data as any, version: 1, versionHistory: [] as any },
    });
  }

  async getVersions(wid: string, tid: string) { const t = await this.findOne(wid, tid); return t.versionHistory; }
}

@Controller('workspaces/:wid/templates') @UseGuards(WorkspaceGuard)
export class TemplatesController {
  constructor(private svc: TemplatesService) {}
  @Post() async create(@Param('wid') w: string, @Body() d: CreateTemplateDto, @CurrentMember() m: any) { return successResponse(await this.svc.create(w, d, m.id)); }
  @Get() async findAll(@Param('wid') w: string, @CurrentMember() m: any, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p.page, p.perPage); return successResponse(r.templates, r.meta); }
  @Get(':tid') async findOne(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.findOne(w, t)); }
  @Patch(':tid') async update(@Param('wid') w: string, @Param('tid') t: string, @Body() d: any, @CurrentMember() m: any) { return successResponse(await this.svc.update(w, t, d, m.id)); }
  @Delete(':tid') async remove(@Param('wid') w: string, @Param('tid') t: string) { await this.svc.remove(w, t); return successResponse({ deleted: true }); }
  @Post(':tid/duplicate') async dup(@Param('wid') w: string, @Param('tid') t: string, @CurrentMember() m: any) { return successResponse(await this.svc.duplicate(w, t, m.id)); }
  @Get(':tid/versions') async versions(@Param('wid') w: string, @Param('tid') t: string) { return successResponse(await this.svc.getVersions(w, t)); }
}

@Module({ controllers: [TemplatesController], providers: [TemplatesService], exports: [TemplatesService] })
export class TemplatesModule {}
