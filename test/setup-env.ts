// Test env. Loads BEFORE any module under test. Picks defaults that work with the
// local Postgres container started by docker (`taskforge-test-db` on :5433).
// Mirror the BigInt JSON polyfill from src/main.ts — the test app bootstrap
// doesn't import main.ts, so audit-log rows (BigInt id) would otherwise 500.
(BigInt.prototype as any).toJSON = function () { return this.toString(); };
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://postgres:test@localhost:5433/taskforge_test';
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.JWT_ACCESS_SECRET ||= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret';
process.env.JWT_ACCESS_EXPIRY ||= '15m';
process.env.JWT_REFRESH_EXPIRY ||= '7d';
process.env.APP_URL ||= 'http://localhost:3000';
process.env.API_URL ||= 'http://localhost:3001';
process.env.INBOUND_EMAIL_DOMAIN ||= 'inbound.test.local';
process.env.INBOUND_WEBHOOK_SECRET ||= 'test-webhook-secret';
process.env.PORT ||= '0';

// BullMQ has its own nested ioredis copy, so module-level mocks don't reliably
// hit it. We point REDIS_URL at the test Redis container (port 6380) and let
// BullMQ talk to a real instance — fast enough on localhost and avoids the
// mock/real mismatch.
