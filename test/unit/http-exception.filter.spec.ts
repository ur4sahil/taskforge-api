import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

function makeHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  it('serialises an HttpException with a string message', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost();

    filter.catch(new NotFoundException('Task not found'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: HttpStatus.NOT_FOUND, message: 'Task not found' },
    });
  });

  it('extracts message from an HttpException whose response is an object', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost();

    // Nest builds a response like { statusCode, message, error } when you throw with an object
    filter.catch(
      new HttpException({ statusCode: 403, message: 'Forbidden action', error: 'Forbidden' }, 403),
      host,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 403, message: 'Forbidden action' },
    });
  });

  it('joins array-of-strings messages (e.g. class-validator errors) with "; "', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost();

    filter.catch(
      new BadRequestException(['name must be a string', 'email must be an email']),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: HttpStatus.BAD_REQUEST,
        message: 'name must be a string; email must be an email',
      },
    });
  });

  it('falls back to 500 + "Unexpected error" for non-HttpException throwables', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost();

    filter.catch(new Error('boom — DB exploded'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Unexpected error' },
    });
  });

  it('falls back to "Unexpected error" when an HttpException response object has no message field', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost();

    // statusCode is propagated but message is missing → default fallback kicks in
    filter.catch(new HttpException({ statusCode: 418 } as any, 418), host);

    expect(status).toHaveBeenCalledWith(418);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 418, message: 'Unexpected error' },
    });
  });

  it('propagates a non-standard HTTP status code from the exception', () => {
    const filter = new HttpExceptionFilter();
    const { host, status } = makeHost();

    filter.catch(new HttpException('teapot', 418), host);

    expect(status).toHaveBeenCalledWith(418);
  });
});
