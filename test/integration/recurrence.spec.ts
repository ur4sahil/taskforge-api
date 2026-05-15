import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createTask } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('Recurrence', () => {
  it('POST creates a recurrence rule and computes nextOccurrence', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const due = new Date('2030-06-01T00:00:00.000Z');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: due });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/recurrence`)
      .set(authHeader(user.id, user.email))
      .send({ frequency: 'weekly', interval: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.frequency).toBe('weekly');
    expect(res.body.data.interval).toBe(1);
    expect(new Date(res.body.data.nextOccurrence).toISOString()).toBe('2030-06-08T00:00:00.000Z');
  });

  it('PATCH updates frequency', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: new Date('2030-06-01') });
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/recurrence`)
      .set(authHeader(user.id, user.email))
      .send({ frequency: 'weekly', interval: 1 });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/recurrence`)
      .set(authHeader(user.id, user.email))
      .send({ frequency: 'monthly' });
    expect(res.status).toBe(200);
    expect(res.body.data.frequency).toBe('monthly');
  });

  it('DELETE deactivates (soft-removes) the rule', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: new Date('2030-06-01') });
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/recurrence`)
      .set(authHeader(user.id, user.email))
      .send({ frequency: 'daily', interval: 1 });

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/recurrence`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);

    const rule = await prisma().recurrenceRule.findFirst({ where: { taskId: task.id } });
    expect(rule).not.toBeNull();
    expect(rule!.isActive).toBe(false);
  });
});
