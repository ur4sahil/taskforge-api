// Run once before the entire Jest suite. Pushes the Prisma schema to the test
// database. Idempotent — if schema is current, prisma db push is a near-no-op.
import { execSync } from 'child_process';
import * as path from 'path';

export default async function () {
  const root = path.resolve(__dirname, '..');
  process.env.DATABASE_URL ||= 'postgresql://postgres:test@localhost:5433/taskforge_test';
  process.env.DIRECT_URL ||= process.env.DATABASE_URL;
  try {
    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH },
    });
  } catch (err: any) {
    console.error('Prisma db push failed:', err?.stdout?.toString?.() || err.message);
    throw err;
  }
}
