// Run once before the entire Jest suite. Pushes the Prisma schema to the test
// database, then re-applies prisma/migrations/custom_indexes.sql — `db push`
// drops every index it does not know about, and search relies on the trigram
// indexes in that file, so tests run against the same indexes as prod.
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

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
  const prisma = new PrismaClient();
  try {
    const sql = fs.readFileSync(path.join(root, 'prisma/migrations/custom_indexes.sql'), 'utf8');
    const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
    for (const s of statements) await prisma.$executeRawUnsafe(s);
  } finally {
    await prisma.$disconnect();
  }
}
