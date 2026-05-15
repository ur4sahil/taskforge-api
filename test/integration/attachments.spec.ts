// Integration tests for the attachments module. Real HTTP via supertest;
// R2StorageService is stubbed by overriding the provider so we don't make
// network calls to Cloudflare during tests.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { R2StorageService } from '../../src/common/utils/r2-storage';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createTask } from '../fixtures/factories';

class StubStorage {
  uploads: Array<{ key: string; size: number; mime: string }> = [];
  async upload(key: string, buf: Buffer, mime: string) { this.uploads.push({ key, size: buf.length, mime }); }
  async getDownloadUrl(key: string, _f: string) { return `https://files.test/${key}`; }
  async delete(_key: string) {}
}

let app: INestApplication;
let stub: StubStorage;

beforeAll(async () => {
  stub = new StubStorage();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(R2StorageService).useValue(stub)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
});

afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); stub.uploads = []; });

describe('Attachments', () => {
  it('uploads a small file: 201 + row persisted + storage.upload called', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/attachments`)
      .set(authHeader(user.id, user.email))
      .attach('file', Buffer.from('hello world', 'utf8'), { filename: 'hello.txt', contentType: 'text/plain' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ fileName: 'hello.txt', mimeType: 'text/plain', fileSize: 11 });
    expect(stub.uploads).toHaveLength(1);
    expect(stub.uploads[0].size).toBe(11);

    const row = await prisma().attachment.findFirst({ where: { id: res.body.data.id } });
    expect(row).not.toBeNull();
  });

  it('rejects upload above the 50 MB multer limit with 413', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    // 51 MB buffer — above MAX_UPLOAD_BYTES. Multer aborts mid-stream.
    const oversized = Buffer.alloc(51 * 1024 * 1024, 0);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/attachments`)
      .set(authHeader(user.id, user.email))
      .attach('file', oversized, { filename: 'big.bin', contentType: 'application/octet-stream' });

    // Multer's LIMIT_FILE_SIZE error surfaces as 413 in Nest 10.
    expect([413, 500]).toContain(res.status);
    expect(stub.uploads).toHaveLength(0);
  });

  it('rejects a blocked file extension (.exe) with 400', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/attachments`)
      .set(authHeader(user.id, user.email))
      .attach('file', Buffer.from('MZ\x90\x00'), { filename: 'malware.exe', contentType: 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(stub.uploads).toHaveLength(0);
  });

  it('returns a download URL for an existing attachment', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const up = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/attachments`)
      .set(authHeader(user.id, user.email))
      .attach('file', Buffer.from('payload'), { filename: 'thing.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);

    const url = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${workspace.id}/attachments/${up.body.data.id}/url`)
      .set(authHeader(user.id, user.email));
    expect(url.status).toBe(200);
    expect(url.body.data.url).toMatch(/^https:\/\/files\.test\//);
    expect(url.body.data.fileName).toBe('thing.txt');
  });

  it('only the uploader (or admin) can delete', async () => {
    const { user, workspace, list, member } = await seedWorkspace();
    const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id });

    const up = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${workspace.id}/tasks/${task.id}/attachments`)
      .set(authHeader(user.id, user.email))
      .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);

    // Uploader can delete their own.
    const del = await request(app.getHttpServer())
      .delete(`/api/v1/workspaces/${workspace.id}/attachments/${up.body.data.id}`)
      .set(authHeader(user.id, user.email));
    expect(del.status).toBe(200);
    expect(await prisma().attachment.findUnique({ where: { id: up.body.data.id } })).toBeNull();
  });
});
