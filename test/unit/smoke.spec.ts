import { prisma, truncateAll, disconnect } from '../fixtures/db';

afterAll(async () => { await disconnect(); });

describe('test harness', () => {
  it('connects to the test database', async () => {
    const rows = await prisma().$queryRaw<{ ok: number }[]>`select 1::int as ok`;
    expect(rows[0].ok).toBe(1);
  });

  it('truncateAll runs without error on an empty DB', async () => {
    await expect(truncateAll()).resolves.toBeUndefined();
  });
});
