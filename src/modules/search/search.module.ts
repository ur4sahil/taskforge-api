import { Injectable, Module, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto } from '../../common/dto/response.dto';

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}
  async search(wid: string, q: string, page: number, perPage: number) {
    if (!q || q.trim().length === 0) return { tasks: [], comments: [] };
    const tasks = await this.prisma.task.findMany({
      where: { workspaceId: wid, deletedAt: null, OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] },
      include: { list: { select: { name: true } }, assignee: { include: { user: { select: { name: true } } } } },
      take: perPage, skip: (page - 1) * perPage,
    });
    const comments = await this.prisma.comment.findMany({
      where: { body: { contains: q, mode: 'insensitive' }, task: { workspaceId: wid, deletedAt: null } },
      include: { task: { select: { id: true, title: true } }, author: { include: { user: { select: { name: true } } } } },
      take: 10,
    });
    return { tasks, comments };
  }
}

@Controller('workspaces/:wid/search') @UseGuards(WorkspaceGuard)
export class SearchController {
  constructor(private svc: SearchService) {}
  @Get() async search(@Param('wid') w: string, @Query('q') q: string, @Query() p: PaginationDto) { return successResponse(await this.svc.search(w, q || '', p.page, p.perPage)); }
}

@Module({ controllers: [SearchController], providers: [SearchService], exports: [SearchService] })
export class SearchModule {}
