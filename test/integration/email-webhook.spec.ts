import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { seedWorkspace, createUser, addMember, createList } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const SECRET = process.env.INBOUND_WEBHOOK_SECRET || 'test-webhook-secret';

describe('Email Webhook', () => {
  it('POST without secret header returns 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/inbound-email')
      .send({ to: 'unknown@inbound.test.local', from: 's@x.com', subject: 'hi', text: 'body' });
    expect(res.status).toBe(401);
  });

  it('POST with wrong secret returns 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/inbound-email')
      .set('x-inbound-secret', 'wrong-secret')
      .send({ to: 'unknown@inbound.test.local', from: 's@x.com', subject: 'hi', text: 'body' });
    expect(res.status).toBe(401);
  });

  it('valid secret + unknown To: returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/inbound-email')
      .set('x-inbound-secret', SECRET)
      .send({ to: 'nobody-here@inbound.test.local', from: 's@x.com', subject: 'hi', text: 'body' });
    expect(res.status).toBe(400);
  });

  it('valid secret + active inbound list creates task with source=email + TaskEmailMetadata row', async () => {
    const { workspace, member } = await seedWorkspace();
    const list = await createList({ workspaceId: workspace.id, createdById: member.id, inboundEmailEnabled: true });

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/inbound-email')
      .set('x-inbound-secret', SECRET)
      .send({
        to: list.inboundEmail!,
        from: 'outside@example.com',
        subject: 'Reset my pw',
        text: 'Body of the email',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.taskId).toEqual(expect.any(String));

    const task = await prisma().task.findUnique({ where: { id: res.body.data.taskId } });
    expect(task).not.toBeNull();
    expect(task!.source).toBe('email');
    expect(task!.title).toBe('Reset my pw');
    expect(task!.listId).toBe(list.id);

    const meta = await prisma().taskEmailMetadata.findUnique({ where: { taskId: task!.id } });
    expect(meta).not.toBeNull();
    expect(meta!.fromAddress).toBe('outside@example.com');
    expect(meta!.toAddress).toBe(list.inboundEmail!.toLowerCase());
    expect(meta!.subject).toBe('Reset my pw');
  });

  it('sender matching a workspace member sets task.creatorId to that member', async () => {
    const { workspace, member: adminMember } = await seedWorkspace();
    const list = await createList({ workspaceId: workspace.id, createdById: adminMember.id, inboundEmailEnabled: true });
    const { user: senderUser } = await createUser();
    const senderMember = await addMember(workspace.id, senderUser.id, 'employee');

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/inbound-email')
      .set('x-inbound-secret', SECRET)
      .send({
        to: list.inboundEmail!,
        from: `"Sender Name" <${senderUser.email}>`,
        subject: 'From a member',
        text: 'authored by a workspace member',
      });
    expect(res.status).toBe(201);
    const task = await prisma().task.findUnique({ where: { id: res.body.data.taskId } });
    expect(task!.creatorId).toBe(senderMember.id);
  });
});
