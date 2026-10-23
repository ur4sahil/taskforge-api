import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { disconnect } from '../fixtures/db';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });

describe('Health', () => {
  it('GET /health is public and reports db + redis ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok', db: 'ok', redis: 'ok' } });
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
  });

  it('does not leak versions or hostnames', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(Object.keys(res.body.data).sort()).toEqual(['db', 'redis', 'status', 'uptimeSeconds']);
  });
});
