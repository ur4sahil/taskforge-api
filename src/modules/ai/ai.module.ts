import { Injectable, Module, Controller, Post, Body, Param, UseGuards, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, IsNotEmpty } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';
import { listScope } from '../../common/utils/list-access';

export const AI_NOT_ENABLED_MESSAGE = "The AI assistant isn't enabled for this workspace yet.";

export class AiChatDto { @IsString() @IsNotEmpty() message: string = ''; }
export class AiParseDto { @IsString() @IsNotEmpty() input: string = ''; }

@Injectable()
export class AiService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}
  async chat(wid: string, member: any, message: string) {
    const key = this.config.get<string>('ai.anthropicApiKey');
    // Surfaced as a 400 so the web shows a real message instead of rendering a
    // dev string as a chat reply; GET /users/me features.ai tells it up front.
    if (!key) throw new BadRequestException(AI_NOT_ENABLED_MESSAGE);
    // The prompt context obeys the same visibility as GET /tasks: non-admins only
    // get tasks from lists they can open; archived and trashed tasks never go in.
    const tasks = await this.prisma.task.findMany({
      where: { workspaceId: wid, deletedAt: null, archivedAt: null, ...(await listScope(this.prisma, wid, member)) },
      select: { id: true, title: true, status: true, priority: true, dueDate: true }, take: 50, orderBy: { updatedAt: 'desc' },
    });
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: `You are TaskForge AI. Help ${member.role} manage tasks. Context: ${JSON.stringify(tasks.slice(0, 20))}`, messages: [{ role: 'user', content: message }] }) });
      const d = await r.json() as any;
      return { response: d.content?.[0]?.text || 'No response' };
    } catch { return { response: 'AI unavailable' }; }
  }
  async parseTask(input: string) {
    const key = this.config.get<string>('ai.anthropicApiKey');
    if (!key) return { title: input, confidence: 0 };
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: 'Parse into task JSON: { title, dueDate, priority, confidence }. Return ONLY JSON.', messages: [{ role: 'user', content: input }] }) });
      const d = await r.json() as any;
      return JSON.parse((d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
    } catch { return { title: input, confidence: 0 }; }
  }
}

@Controller('workspaces/:wid/ai') @UseGuards(WorkspaceGuard)
export class AiController {
  constructor(private svc: AiService) {}
  @Post('chat') async chat(@Param('wid') w: string, @Body() d: AiChatDto, @CurrentMember() m: any) { return successResponse(await this.svc.chat(w, m, d.message)); }
  @Post('parse-task') async parse(@Body() d: AiParseDto) { return successResponse(await this.svc.parseTask(d.input)); }
}

@Module({ controllers: [AiController], providers: [AiService], exports: [AiService] })
export class AiModule {}
