import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

// Prisma "known request" errors that are really client errors, not crashes.
// Anything else from Prisma (connection drops, raw query failures) stays a 500.
const PRISMA_STATUS: Record<string, { status: number; message: string }> = {
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Not found' },
  P2002: { status: HttpStatus.CONFLICT, message: 'Already exists' },
  P2003: { status: HttpStatus.BAD_REQUEST, message: 'Referenced record does not exist' },
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Unexpected error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      const raw = typeof r === 'string' ? r : (r as any).message;
      message = Array.isArray(raw) ? raw.join('; ') : (raw || message);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && PRISMA_STATUS[exception.code]) {
      ({ status, message } = PRISMA_STATUS[exception.code]);
    }

    // Every 500 used to leave the process with no trace at all — the client got
    // "Unexpected error" and the server log stayed empty. Log the stack with
    // enough request context to find it again; never log the body (credentials).
    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      const who = (req as any)?.user?.userId ? ` user=${(req as any).user.userId}` : '';
      this.logger.error(`${req?.method} ${req?.originalUrl ?? req?.url} → ${status}${who}: ${err.message}`, err.stack);
    }

    res.status(status).json({ success: false, error: { code: status, message } });
  }
}
