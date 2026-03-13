import { Injectable, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';

export class CreateViewDto { @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; @IsString() type: string = 'list'; @IsOptional() filters?: any; @IsOptional() sort?: any; @IsOptional() @IsString() groupBy?: string; @IsOptional() @IsString() visibility?: string; }

@Injectable()
export class ViewsService {
  constructor(private prisma: PrismaService) {}
  async create(wid: string, d: CreateViewDto, mid: string) {
    return this.prisma.savedView.create({ data: { workspaceId: wid, createdById: mid, name: d.name, type: d.type as any, filters: (d.filters ?? {}) as any, sort: (d.sort ?? {}) as any, groupBy: d.groupBy ?? null, visibility: (d.visibility ?? 'personal') as any } });
  }
  async findAll(wid: string, mid: string, page: number, perPage: number) {
    const where: any = { workspaceId: wid, OR: [{ visibility: 'shared' }, { createdById: mid }] };
    const [v, n] = await Promise.all([this.prisma.savedView.findMany({ where, skip: (page - 1) * perPage, take: perPage }), this.prisma.savedView.count({ where })]);
    return { views: v, meta: paginationMeta(n, page, perPage) };
  }
  async update(vid: string, d: any) {
    const data: any = {};
    if (d.name) data.name = d.name;
    if (d.type) data.type = d.type;
    if (d.filters) data.filters = d.filters as any;
    if (d.sort) data.sort = d.sort as any;
    if (d.groupBy !== undefined) data.groupBy = d.groupBy;
    if (d.visibility) data.visibility = d.visibility;
    return this.prisma.savedView.update({ where: { id: vid }, data });
  }
  async remove(vid: string) { await this.prisma.savedView.delete({ where: { id: vid } }); }
}

@Controller('workspaces/:wid/views') @UseGuards(WorkspaceGuard)
export class ViewsController {
  constructor(private svc: ViewsService) {}
  @Post() async create(@Param('wid') w: string, @Body() d: CreateViewDto, @CurrentMember() m: any) { return successResponse(await this.svc.create(w, d, m.id)); }
  @Get() async findAll(@Param('wid') w: string, @CurrentMember() m: any, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p.page, p.perPage); return successResponse(r.views, r.meta); }
  @Patch(':vid') async update(@Param('vid') v: string, @Body() d: any) { return successResponse(await this.svc.update(v, d)); }
  @Delete(':vid') async remove(@Param('vid') v: string) { await this.svc.remove(v); return successResponse({ deleted: true }); }
}

@Module({ controllers: [ViewsController], providers: [ViewsService], exports: [ViewsService] })
export class ViewsModule {}
