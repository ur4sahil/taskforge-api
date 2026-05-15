import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember, createTask } from '../fixtures/factories';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe('Comments', () => {
  it('POST creates a comment with the author resolved', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments`)
      .set(authHeader(user.id, user.email))
      .send({ body: 'Plain comment, no mentions.' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ body: 'Plain comment, no mentions.' });
    expect(res.body.data.author).toBeTruthy();
  });

  it('GET /comments lists comments for the task in chronological order', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    await prisma().comment.create({ data: { taskId: task.id, authorId: member.id, body: 'first' } });
    await prisma().comment.create({ data: { taskId: task.id, authorId: member.id, body: 'second' } });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments`)
      .set(authHeader(user.id, user.email));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data.map((c: any) => c.body)).toEqual(['first', 'second']);
  });

  it('mention parsing: @email creates a Mention row and a Notification for the mentioned member', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const { user: alice } = await createUser();
    const aliceMember = await addMember(workspace.id, alice.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id });

    const body = `Hey @${alice.email} please look at this.`;
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments`)
      .set(authHeader(admin.id, admin.email))
      .send({ body });
    expect(res.status).toBe(201);

    const mentions = await prisma().mention.findMany({ where: { commentId: res.body.data.id } });
    expect(mentions).toHaveLength(1);
    expect(mentions[0].mentionedMemberId).toBe(aliceMember.id);

    const notifs = await prisma().notification.findMany({ where: { recipientId: aliceMember.id, type: 'mention' } });
    expect(notifs.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE allows the author to remove their own comment + cascades to mentions', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const { user: alice } = await createUser();
    await addMember(workspace.id, alice.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id });

    const create = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments`)
      .set(authHeader(admin.id, admin.email))
      .send({ body: `hi @${alice.email}` });
    expect(create.status).toBe(201);
    const cid = create.body.data.id;
    expect((await prisma().mention.findMany({ where: { commentId: cid } })).length).toBe(1);

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments/${cid}`)
      .set(authHeader(admin.id, admin.email));
    expect(del.status).toBe(200);
    expect(await prisma().comment.findUnique({ where: { id: cid } })).toBeNull();
    expect(await prisma().mention.findMany({ where: { commentId: cid } })).toHaveLength(0);
  });

  it('DELETE forbids non-author non-admin from removing someone else\'s comment', async () => {
    const { user: admin, workspace, list, member: adminMember } = await seedWorkspace();
    const { user: emp } = await createUser();
    await addMember(workspace.id, emp.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: adminMember.id });

    const create = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments`)
      .set(authHeader(admin.id, admin.email))
      .send({ body: 'admins note' });
    const cid = create.body.data.id;

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments/${cid}`)
      .set(authHeader(emp.id, emp.email));
    expect(del.status).toBe(403);
    expect(await prisma().comment.findUnique({ where: { id: cid } })).not.toBeNull();
  });

  it('DELETE allows admin to remove someone else\'s comment', async () => {
    const { user: admin, workspace, list } = await seedWorkspace();
    const { user: emp } = await createUser();
    const empMember = await addMember(workspace.id, emp.id, 'employee');
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: empMember.id });

    const c = await prisma().comment.create({ data: { taskId: task.id, authorId: empMember.id, body: 'emp comment' } });
    const del = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments/${c.id}`)
      .set(authHeader(admin.id, admin.email));
    expect(del.status).toBe(200);
    expect(await prisma().comment.findUnique({ where: { id: c.id } })).toBeNull();
  });

  it('mentioning self does not create a Mention or self-notification', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const body = `Note to self: @${user.email} fix this`;
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/comments`)
      .set(authHeader(user.id, user.email))
      .send({ body });
    expect(res.status).toBe(201);

    const mentions = await prisma().mention.findMany({ where: { commentId: res.body.data.id } });
    expect(mentions).toHaveLength(0);

    const selfNotifs = await prisma().notification.findMany({ where: { recipientId: member.id, type: 'mention' } });
    expect(selfNotifs).toHaveLength(0);
  });
});
