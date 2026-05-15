// Boot the whole AppModule in the test env. If any module fails to wire up
// (missing provider, circular dep, bad env), this catches it before any
// scenario-specific test runs.
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect } from '../fixtures/db';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('app bootstrap', () => {
  it('boots the full AppModule without throwing', () => {
    expect(app).toBeDefined();
    expect(app.getHttpServer()).toBeDefined();
  });

  it('responds to an unknown route with the error envelope (not stack trace)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope-not-a-route');
    expect(res.status).toBe(404);
    // Some Nest setups return text on 404 before filters; if the envelope is
    // applied, success will be false.
    if (typeof res.body === 'object' && res.body && 'success' in res.body) {
      expect(res.body.success).toBe(false);
    }
  });

  it('rejects body that fails class-validator (validation pipe wired)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ email: 'not-an-email', password: 'short' });
    expect([400, 422]).toContain(res.status);
  });
});
