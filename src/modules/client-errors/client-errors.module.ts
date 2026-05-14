import { Body, Controller, HttpCode, Logger, Module, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../../common/decorators';
import { successResponse } from '../../common/dto/response.dto';

/**
 * Public client-error sink. Used by the web app's ErrorBoundary to beacon
 * React render crashes (TDZ, chunk-load failures, etc.) so we can see them
 * server-side without needing iOS Safari devtools.
 *
 * Public on purpose — errors may fire before auth is established, and a JWT
 * round-trip via the beacon path is unreliable on iOS Safari. The endpoint
 * just logs; it doesn't persist or echo, so it's safe to leave open.
 */

export class ClientErrorDto {
  @IsString() @MaxLength(2000) message: string = '';
  @IsOptional() @IsString() @MaxLength(8000) stack?: string;
  @IsOptional() @IsString() @MaxLength(500) url?: string;
  @IsOptional() @IsString() @MaxLength(500) userAgent?: string;
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) memberId?: string;
  @IsOptional() @IsString() @MaxLength(200) buildId?: string;
}

@Controller('client-errors')
export class ClientErrorsController {
  private readonly log = new Logger('ClientError');

  @Public()
  @Post()
  @HttpCode(202)
  async report(@Body() dto: ClientErrorDto) {
    // Format: one log line per beacon, with everything needed to trace.
    const ua = (dto.userAgent || '').slice(0, 120);
    const ws = dto.workspaceId ? `ws=${dto.workspaceId.slice(0, 8)}` : 'ws=?';
    const mem = dto.memberId ? `mem=${dto.memberId.slice(0, 8)}` : 'mem=?';
    const url = dto.url || '?';
    this.log.warn(`[client] ${ws} ${mem} url=${url} ua="${ua}" msg=${JSON.stringify(dto.message)}`);
    if (dto.stack) {
      // Stack on a separate line so multi-frame stacks remain greppable.
      this.log.warn(`[client] stack: ${dto.stack.slice(0, 1500)}`);
    }
    return successResponse({ ok: true });
  }
}

@Module({ controllers: [ClientErrorsController] })
export class ClientErrorsModule {}
