import 'reflect-metadata';
import { successResponse, errorResponse, paginationMeta } from '../../src/common/dto/response.dto';

describe('successResponse', () => {
  it('wraps plain data without a meta key', () => {
    const out = successResponse({ id: 1, name: 'task' });
    expect(out).toEqual({ success: true, data: { id: 1, name: 'task' } });
    expect((out as any).meta).toBeUndefined();
  });

  it('includes meta when a PaginationMeta is provided', () => {
    const meta = { page: 2, perPage: 25, total: 100, totalPages: 4 };
    const out = successResponse([{ id: 1 }, { id: 2 }], meta);
    expect(out).toEqual({
      success: true,
      data: [{ id: 1 }, { id: 2 }],
      meta,
    });
  });

  it('preserves null data', () => {
    const out = successResponse(null);
    expect(out).toEqual({ success: true, data: null });
  });

  it('preserves empty array data', () => {
    const out = successResponse([]);
    expect(out).toEqual({ success: true, data: [] });
  });

  it('preserves deeply nested object structure', () => {
    const data = {
      task: { id: 'a', sub: { items: [1, 2, 3], owner: { name: 'sahil' } } },
    };
    const out = successResponse(data);
    expect(out).toEqual({ success: true, data });
    expect((out as any).data.task.sub.owner.name).toBe('sahil');
  });

  it('does not mutate the passed-in data object', () => {
    const data = { a: 1 };
    successResponse(data);
    expect(data).toEqual({ a: 1 });
  });
});

describe('errorResponse', () => {
  it('returns a structured error envelope with code and message', () => {
    expect(errorResponse('NOT_FOUND', 'Task not found')).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });
  });
});

describe('paginationMeta', () => {
  it('computes totalPages as ceiling(total / perPage)', () => {
    expect(paginationMeta(100, 1, 25)).toEqual({
      page: 1,
      perPage: 25,
      total: 100,
      totalPages: 4,
    });
    expect(paginationMeta(101, 1, 25).totalPages).toBe(5);
  });

  it('returns 0 totalPages when total is 0', () => {
    expect(paginationMeta(0, 1, 25)).toEqual({
      page: 1,
      perPage: 25,
      total: 0,
      totalPages: 0,
    });
  });
});
