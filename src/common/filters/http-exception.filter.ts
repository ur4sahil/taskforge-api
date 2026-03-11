import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(ex: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR, msg = 'Unexpected error';
    if (ex instanceof HttpException) { status = ex.getStatus(); const r = ex.getResponse(); msg = typeof r === 'string' ? r : (r as any).message || msg; }
    res.status(status).json({ success: false, error: { code: status, message: msg } });
  }
}
