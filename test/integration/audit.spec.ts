import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function waitForAudit(workspaceId: string, action: string, tries = 25, delayMs = 40): Promise<any | null> {
  for (let i = 0; i < tries; i += 1) {
    const row = await prisma().auditLog.findFirst({ where: { workspaceId, action } });
    if (row) return row;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

describe('Audit Log', () => {
  it('non-GET request (create task) writes an audit_log row', async () => {
    const { user, workspace, list } = await seedWorkspace();
    const create = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/lists/${list.id}/tasks`)
      .set(authHeader(user.id, user.email))
      .send({ title: 'Audited task' });
    expect(create.status).toBe(201);

    const log = await waitForAudit(workspace.id, 'task.created');
    expect(log).not.toBeNull();
    expect(log!.entityType).toBe('task');
    expect(log!.entityId).toBe(create.body.data.id);
  });

  it('admin can read audit logs (empty workspace)', async () => {
    const { user, workspace } = await seedWorkspace();
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/audit-logs`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('admin can read audit logs (non-empty — BigInt id serializes as string)', async () => {
    const { user, workspace, list } = await seedWorkspace();
    // Trigger an audit row by creating a task.
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/lists/${list.id}/tasks`)
      .set(authHeader(user.id, user.email))
      .send({ title: 'For audit' });
    await waitForAudit(workspace.id, 'task.created');
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/audit-logs`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    // BigInt id must be returned as a JSON-safe string (numeric digits only).
    expect(typeof res.body.data[0].id).toBe('string');
    expect(res.body.data[0].id).toMatch(/^\d+$/);
  });

  it('employee gets 403 on audit log endpoint', async () => {
    const { workspace } = await seedWorkspace();
    const { user: emp } = await createUser();
    await addMember(workspace.id, emp.id, 'employee');
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/audit-logs`)
      .set(authHeader(emp.id, emp.email));
    expect(res.status).toBe(403);
  });
});
