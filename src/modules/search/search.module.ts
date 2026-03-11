import { Injectable, Module, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard } from '@/common/guards';
import { successResponse, PaginationDto } from '@/common/dto/response.dto';
@Injectable() export class SearchService {
  constructor(private prisma: PrismaService) {}
  async search(wid: string, q: string, p: PaginationDto) {
    const tasks = await this.prisma.$queryRaw<any[]>`SELECT id, title, description, status, priority, due_date, ts_rank(to_tsvector('english', title || ' ' || coalesce(description, '')), plainto_tsquery('english', ${q})) as rank FROM tasks WHERE workspace_id = ${wid}::uuid AND deleted_at IS NULL AND to_tsvector('english', title || ' ' || coalesce(description, '')) @@ plainto_tsquery('english', ${q}) ORDER BY rank DESC LIMIT ${p.perPage} OFFSET ${(p.page-1)*p.perPage}`;
    const comments = await this.prisma.$queryRaw<any[]>`SELECT c.id, c.body, c.task_id, c.created_at FROM comments c JOIN tasks t ON c.task_id = t.id WHERE t.workspace_id = ${wid}::uuid AND t.deleted_at IS NULL AND to_tsvector('english', c.body) @@ plainto_tsquery('english', ${q}) ORDER BY c.created_at DESC LIMIT 10`;
    return { tasks, comments };
  }
}
@Controller('workspaces/:wid/search') @UseGuards(WorkspaceGuard) export class SearchController { constructor(private svc: SearchService) {} @Get() async search(@Param('wid') w: string, @Query('q') q: string, @Query() p: PaginationDto) { return successResponse(await this.svc.search(w, q||'', p)); } }
@Module({ controllers: [SearchController], providers: [SearchService], exports: [SearchService] }) export class SearchModule {}
