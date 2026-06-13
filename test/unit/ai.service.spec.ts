// Unit tests for AiService with an API key present. global.fetch is stubbed so
// the Anthropic call is never made. The no-key fallback paths are covered in the
// ai integration spec.
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../src/modules/ai/ai.module';

function makeConfig(key?: string): ConfigService {
  return { get: (k: string) => (k === 'ai.anthropicApiKey' ? key : undefined) } as any;
}
const prismaStub = { task: { findMany: jest.fn().mockResolvedValue([{ id: 't1', title: 'Task', status: 'todo' }]) } } as any;

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

function mockFetch(text: string) {
  global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ content: [{ text }] }) }) as any;
}

describe('AiService.chat (with key)', () => {
  it('returns the model text from the Anthropic response', async () => {
    mockFetch('Focus on the overdue task first.');
    const svc = new AiService(prismaStub, makeConfig('sk-ant-test'));
    const out = await svc.chat('ws1', { role: 'manager' }, 'What next?');
    expect(out).toEqual({ response: 'Focus on the overdue task first.' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back gracefully when the request throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;
    const svc = new AiService(prismaStub, makeConfig('sk-ant-test'));
    const out = await svc.chat('ws1', { role: 'employee' }, 'hi');
    expect(out).toEqual({ response: 'AI unavailable' });
  });

  it('returns "No response" when content is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ content: [] }) }) as any;
    const svc = new AiService(prismaStub, makeConfig('sk-ant-test'));
    const out = await svc.chat('ws1', { role: 'admin' }, 'hi');
    expect(out).toEqual({ response: 'No response' });
  });
});

describe('AiService.parseTask (with key)', () => {
  it('parses clean JSON from the model', async () => {
    mockFetch('{"title":"Call plumber","priority":"high","confidence":0.9}');
    const svc = new AiService(prismaStub, makeConfig('sk-ant-test'));
    const out = await svc.parseTask('call plumber tomorrow, urgent');
    expect(out).toMatchObject({ title: 'Call plumber', priority: 'high', confidence: 0.9 });
  });

  it('strips ```json code fences before parsing', async () => {
    mockFetch('```json\n{"title":"Buy milk","confidence":0.5}\n```');
    const svc = new AiService(prismaStub, makeConfig('sk-ant-test'));
    const out = await svc.parseTask('buy milk');
    expect(out).toMatchObject({ title: 'Buy milk', confidence: 0.5 });
  });

  it('falls back to the raw input with zero confidence on bad JSON', async () => {
    mockFetch('not json at all');
    const svc = new AiService(prismaStub, makeConfig('sk-ant-test'));
    const out = await svc.parseTask('some input');
    expect(out).toEqual({ title: 'some input', confidence: 0 });
  });
});
