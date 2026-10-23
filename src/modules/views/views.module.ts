import { Injectable, NotFoundException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
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
  /** Scoped to the workspace. A personal view is only reachable by its owner (or
   *  an admin); anyone else gets the same 404 findAll's filter implies — the view
   *  is invisible to them, so we must not confirm it exists. Shared views stay
   *  editable by any member, as before. */
  private async findEditable(wid: string, vid: string, member: any) {
    const v = await this.prisma.savedView.findFirst({ where: { id: vid, workspaceId: wid }, select: { id: true, createdById: true, visibility: true } });
    if (!v) throw new NotFoundException('View not found');
    if (v.visibility === 'personal' && v.createdById !== member.id && member.role !== 'admin') throw new NotFoundException('View not found');
    return v;
  }
  async update(wid: string, vid: string, d: any, member: any) {
    await this.findEditable(wid, vid, member);
    const data: any = {};
    if (d.name) data.name = d.name;
    if (d.type) data.type = d.type;
    if (d.filters) data.filters = d.filters as any;
    if (d.sort) data.sort = d.sort as any;
    if (d.groupBy !== undefined) data.groupBy = d.groupBy;
    if (d.visibility) data.visibility = d.visibility;
    return this.prisma.savedView.update({ where: { id: vid }, data });
  }
  async remove(wid: string, vid: string, member: any) { await this.findEditable(wid, vid, member); await this.prisma.savedView.delete({ where: { id: vid } }); }
}

@Controller('workspaces/:wid/views') @UseGuards(WorkspaceGuard)
export class ViewsController {
  constructor(private svc: ViewsService) {}
  @Post() async create(@Param('wid') w: string, @Body() d: CreateViewDto, @CurrentMember() m: any) { return successResponse(await this.svc.create(w, d, m.id)); }
  @Get() async findAll(@Param('wid') w: string, @CurrentMember() m: any, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, m.id, p.page, p.perPage); return successResponse(r.views, r.meta); }
  @Patch(':vid') async update(@Param('wid') w: string, @Param('vid') v: string, @Body() d: any, @CurrentMember() m: any) { return successResponse(await this.svc.update(w, v, d, m)); }
  @Delete(':vid') async remove(@Param('wid') w: string, @Param('vid') v: string, @CurrentMember() m: any) { await this.svc.remove(w, v, m); return successResponse({ deleted: true }); }
}

@Module({ controllers: [ViewsController], providers: [ViewsService], exports: [ViewsService] })
export class ViewsModule {}
