// WorkerScheduler registers the five repeatable ticks on boot. These pin the
// job options: idempotent re-registration (old repeatable removed first) and
// retry/backoff, added after the Supabase pooler's daily connection drops were
// silently losing reminder and overdue ticks.
import { WorkerScheduler } from '../../src/workers/workers.module';

function fakeQueue(existing: { name: string; key: string }[] = []) {
  return {
    getRepeatableJobs: jest.fn().mockResolvedValue(existing),
    removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('WorkerScheduler', () => {
  const savedEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = savedEnv; });

  it('schedules all five ticks with retry + exponential backoff', async () => {
    process.env.NODE_ENV = 'development';
    const qs = { recurring: fakeQueue(), reminders: fakeQueue(), overdue: fakeQueue(), archive: fakeQueue(), trash: fakeQueue() };
    const s = new WorkerScheduler(qs.recurring, qs.reminders, qs.overdue, qs.archive, qs.trash);
    await s.onApplicationBootstrap();

    const calls = Object.values(qs).map(q => q.add.mock.calls[0]);
    expect(calls.map(c => c[0])).toEqual(['recurring-tick', 'reminders-tick', 'overdue-tick', 'archive-tick', 'trash-tick']);
    for (const [, , opts] of calls) {
      expect(opts.attempts).toBe(3);
      expect(opts.backoff).toEqual({ type: 'exponential', delay: 30_000 });
      expect(opts.repeat.pattern).toEqual(expect.any(String));
    }
    expect(qs.reminders.add.mock.calls[0][2].repeat.pattern).toBe('* * * * *');
  });

  it('removes an existing repeatable of the same name before re-adding (idempotent across deploys)', async () => {
    process.env.NODE_ENV = 'development';
    const reminders = fakeQueue([{ name: 'reminders-tick', key: 'old-key' }, { name: 'other', key: 'keep' }]);
    const s = new WorkerScheduler(fakeQueue(), reminders, fakeQueue(), fakeQueue(), fakeQueue());
    await s.onApplicationBootstrap();
    expect(reminders.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(reminders.removeRepeatableByKey).toHaveBeenCalledWith('old-key');
  });

  it('does nothing under NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const q = fakeQueue();
    const s = new WorkerScheduler(q, q, q, q, q);
    await s.onApplicationBootstrap();
    expect(q.add).not.toHaveBeenCalled();
  });
});
