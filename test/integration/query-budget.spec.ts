// Round-trip budget for the hot read endpoints.
//
// Production talks to Postgres across the country (VPS in Ashburn, Supabase in
// us-west-2): every SQL statement costs ~78 ms of network time no matter how
// cheap it is server-side. A Prisma include tree run with the default "query"
// load strategy issues one statement per relation level, so opening a chat
// thread took 3.6 s. These tests count statements per request so a new nested
// include can't silently put that back.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember, createTask } from '../fixtures/factories';

let statements = 0;
class CountingPrisma extends PrismaClient {
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    (this as any).$on('query', () => { statements++; });
  }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}

let app: INestApplication;
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService).useValue(new CountingPrisma())
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
});
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

/** A workspace that looks like real use: 6 people, a group chat with 60
 *  messages carrying reactions, replies and attachments, 4 DMs, 40 tasks. */
async function seed() {
  const s = await seedWorkspace();
  const peers: any[] = [];
  for (let i = 0; i < 6; i++) {
    const { user } = await createUser();
    peers.push(await addMember(s.workspace.id, user.id, 'employee'));
  }
  const everyone = [s.member, ...peers];
  const group = await prisma().conversation.create({
    data: { workspaceId: s.workspace.id, name: 'All hands', createdById: s.member.id, members: { create: everyone.map(m => ({ workspaceMemberId: m.id })) } },
  });
  for (const p of peers.slice(0, 4)) {
    await prisma().conversation.create({
      data: { workspaceId: s.workspace.id, members: { create: [{ workspaceMemberId: s.member.id }, { workspaceMemberId: p.id }] } },
    });
  }
  let prev: string | null = null;
  for (let i = 0; i < 60; i++) {
    const sender = everyone[i % everyone.length];
    const m: any = await prisma().message.create({
      data: { conversationId: group.id, senderId: sender.id, body: `message ${i}`, replyToId: i % 5 === 0 ? prev : null, createdAt: new Date(Date.now() - (60 - i) * 60_000) },
    });
    if (i % 3 === 0) await prisma().messageReaction.create({ data: { messageId: m.id, workspaceMemberId: everyone[(i + 1) % everyone.length].id, emoji: '👍' } });
    if (i % 7 === 0) await prisma().attachment.create({ data: { workspaceId: s.workspace.id, messageId: m.id, uploadedById: sender.id, fileName: 'a.pdf', fileSize: 10, mimeType: 'application/pdf', storageKey: `k/${m.id}` } });
    prev = m.id;
  }
  for (let i = 0; i < 40; i++) {
    await createTask({ workspaceId: s.workspace.id, listId: s.list.id, creatorId: s.member.id, assigneeId: everyone[i % everyone.length].id, dueDate: new Date(Date.now() + (i - 20) * 86400000) });
  }
  return { ...s, group };
}

async function count(path: string, user: any) {
  statements = 0;
  const res = await request(app.getHttpServer()).get(path).set(authHeader(user.id, user.email));
  expect(res.status).toBe(200);
  return { n: statements, body: res.body };
}

// Budgets = measured counts with relationJoins + the one-query WorkspaceGuard.
// Before: conversations 9, messages 15, tasks 11, home 15.
describe('query budget (statements per request)', () => {
  it('chat: conversation list and a thread stay within budget and keep their shape', async () => {
    const { user, workspace, group } = await seed();
    const w = `/api/v1/workspaces/${workspace.id}`;

    const conv = await count(`${w}/conversations`, user);
    expect(conv.n).toBeLessThanOrEqual(3);
    expect(conv.body.data).toHaveLength(5);
    const g = conv.body.data.find((c: any) => c.id === group.id);
    expect(g).toMatchObject({ name: 'All hands', memberCount: 7, lastMessage: { body: 'message 59' } });
    expect(g.members[0].user.name).toEqual(expect.any(String));

    const msgs = await count(`${w}/conversations/${group.id}/messages?perPage=50`, user);
    expect(msgs.n).toBeLessThanOrEqual(5);
    const list = msgs.body.data;
    expect(list).toHaveLength(50);
    expect(list[list.length - 1].body).toBe('message 59');
    expect(list[0].sender.user.name).toEqual(expect.any(String));
    expect(list.some((m: any) => m.reactions.length === 1 && m.reactions[0].workspaceMember.user.name)).toBe(true);
    expect(list.some((m: any) => m.attachments.length === 1 && m.attachments[0].fileName === 'a.pdf')).toBe(true);
    expect(list.some((m: any) => m.replyTo && m.replyTo.sender.user.name)).toBe(true);
  });

  it('tasks, home, lists and notifications stay within budget', async () => {
    const { user, workspace } = await seed();
    const w = `/api/v1/workspaces/${workspace.id}`;
    const tasks = await count(`${w}/tasks?perPage=200`, user);
    expect(tasks.n).toBeLessThanOrEqual(4);
    expect(tasks.body.data).toHaveLength(40);
    expect(tasks.body.data[0].assignee.user.name).toEqual(expect.any(String));
    expect((await count(`${w}/reports/home?scope=mine`, user)).n).toBeLessThanOrEqual(8);
    expect((await count(`${w}/reports/home?scope=all`, user)).n).toBeLessThanOrEqual(8);
    expect((await count(`${w}/lists`, user)).n).toBeLessThanOrEqual(4);
    expect((await count(`${w}/notifications`, user)).n).toBeLessThanOrEqual(4);
  });
});
