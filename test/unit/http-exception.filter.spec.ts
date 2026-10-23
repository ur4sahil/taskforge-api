// Response-shape cases came first; the Prisma-mapping and logging cases were
// added when the filter stopped swallowing 500s. Before that, every
// non-HttpException became "Unexpected error" with nothing in the server log.
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

function makeHost(req: any = { method: 'GET', originalUrl: '/api/v1/x' }) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });
}

describe('HttpExceptionFilter', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });
  afterEach(() => errorSpy.mockRestore());

  describe('response shape', () => {
    it('serialises an HttpException with a string message', () => {
      const { host, status, json } = makeHost();
      new HttpExceptionFilter().catch(new NotFoundException('Task not found'), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(json).toHaveBeenCalledWith({ success: false, error: { code: HttpStatus.NOT_FOUND, message: 'Task not found' } });
    });

    it('extracts message from an HttpException whose response is an object', () => {
      const { host, status, json } = makeHost();
      // Nest builds a response like { statusCode, message, error } when you throw with an object
      new HttpExceptionFilter().catch(new HttpException({ statusCode: 403, message: 'Forbidden action', error: 'Forbidden' }, 403), host);
      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ success: false, error: { code: 403, message: 'Forbidden action' } });
    });

    it('joins array-of-strings messages (e.g. class-validator errors) with "; "', () => {
      const { host, status, json } = makeHost();
      new HttpExceptionFilter().catch(new BadRequestException(['name must be a string', 'email must be an email']), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(json).toHaveBeenCalledWith({
        success: false,
        error: { code: HttpStatus.BAD_REQUEST, message: 'name must be a string; email must be an email' },
      });
    });

    it('falls back to "Unexpected error" when an HttpException response object has no message field', () => {
      const { host, status, json } = makeHost();
      new HttpExceptionFilter().catch(new HttpException({ statusCode: 418 } as any, 418), host);
      expect(status).toHaveBeenCalledWith(418);
      expect(json).toHaveBeenCalledWith({ success: false, error: { code: 418, message: 'Unexpected error' } });
    });

    it('propagates a non-standard HTTP status code from the exception', () => {
      const { host, status } = makeHost();
      new HttpExceptionFilter().catch(new HttpException('teapot', 418), host);
      expect(status).toHaveBeenCalledWith(418);
    });

    it('4xx responses are not logged as errors', () => {
      const { host } = makeHost();
      new HttpExceptionFilter().catch(new NotFoundException('x'), host);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('Prisma mapping', () => {
    it.each([
      ['P2025', HttpStatus.NOT_FOUND],
      ['P2002', HttpStatus.CONFLICT],
      ['P2003', HttpStatus.BAD_REQUEST],
    ])('maps Prisma %s to %i without logging', (code, expected) => {
      const { host, status, json } = makeHost();
      new HttpExceptionFilter().catch(prismaError(code), host);
      expect(status).toHaveBeenCalledWith(expected);
      expect(json.mock.calls[0][0].error.code).toBe(expected);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('unknown Prisma codes (e.g. P1001 connection drop) stay 500 and are logged', () => {
      const { host, status } = makeHost();
      new HttpExceptionFilter().catch(prismaError('P1001'), host);
      expect(status).toHaveBeenCalledWith(500);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('500 logging', () => {
    it('falls back to 500 + "Unexpected error" for non-HttpException throwables', () => {
      const { host, status, json } = makeHost();
      new HttpExceptionFilter().catch(new Error('boom — DB exploded'), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json).toHaveBeenCalledWith({
        success: false,
        error: { code: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Unexpected error' },
      });
    });

    it('logs method, path, user, message and stack; the client never sees the message', () => {
      const err = new TypeError("Cannot read properties of undefined (reading 'id')");
      const { host, json } = makeHost({ method: 'PATCH', originalUrl: '/api/v1/workspaces/w/tasks/t', user: { userId: 'u-1' } });
      new HttpExceptionFilter().catch(err, host);
      expect(json.mock.calls[0][0].error.message).toBe('Unexpected error');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [line, stack] = errorSpy.mock.calls[0];
      expect(line).toContain('PATCH /api/v1/workspaces/w/tasks/t → 500');
      expect(line).toContain('user=u-1');
      expect(line).toContain(err.message);
      expect(stack).toContain('TypeError');
    });

    it('copes with a thrown non-Error value', () => {
      const { host, status, json } = makeHost();
      new HttpExceptionFilter().catch('string thrown', host);
      expect(status).toHaveBeenCalledWith(500);
      expect(json.mock.calls[0][0].error.message).toBe('Unexpected error');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
