import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { disconnect } from '../fixtures/db';

// The client-error sink is a public beacon (no auth) that just logs. We assert
// the contract: accepts beacons with 202, validates field lengths, needs no auth.

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });

const srv = () => app.getHttpServer();

describe('Client error beacon', () => {
  it('accepts a minimal beacon with 202, no auth required', async () => {
    const res = await request(srv())
      .post('/api/v1/client-errors')
      .send({ message: 'TypeError: undefined is not a function' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, data: { ok: true } });
  });

  it('accepts a full beacon including stack and context fields', async () => {
    const res = await request(srv())
      .post('/api/v1/client-errors')
      .send({
        message: 'Chunk load failed',
        stack: 'at foo (app.js:1:1)\nat bar (app.js:2:2)',
        url: 'https://taskforge.housify365.com/lists/abc',
        userAgent: 'Mozilla/5.0 (iPhone)',
        workspaceId: 'ws-123',
        memberId: 'mem-456',
        buildId: 'build-789',
      });
    expect(res.status).toBe(202);
  });

  it('rejects a message that exceeds the 2000-char cap with 400', async () => {
    const res = await request(srv())
      .post('/api/v1/client-errors')
      .send({ message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });
});
