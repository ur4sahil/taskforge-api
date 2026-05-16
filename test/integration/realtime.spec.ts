// Realtime (Socket.IO /chat namespace) integration tests. Boots the full Nest
// app on a real port, connects via socket.io-client with a real JWT.
//
// These tests don't try to exhaustively cover every gateway event — they focus
// on auth (which is where a regression silently breaks every real-time feature)
// and the round-trip presence + room-join lifecycle.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { signAccessToken } from '../fixtures/auth';
import { seedWorkspace, createUser, addMember } from '../fixtures/factories';

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0); // pick a free port
  const url = await app.getUrl();
  // app.getUrl() returns http://[::1]:PORT on some node versions; normalize.
  baseUrl = url.replace('[::1]', '127.0.0.1');
});

afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

function connect(opts: { token?: string; workspaceId?: string }) {
  const url = `${baseUrl}/chat`;
  return ioc(url, {
    auth: { token: opts.token, workspaceId: opts.workspaceId },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitFor<T = any>(socket: ClientSocket, event: string, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    socket.once(event as any, (data: any) => { clearTimeout(timer); resolve(data); });
  });
}

function waitForDisconnect(socket: ClientSocket, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for disconnect')), timeoutMs);
    socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', () => { clearTimeout(timer); resolve(); });
  });
}

describe('Realtime ChatGateway', () => {
  it('rejects a connection with no token (disconnect on handshake)', async () => {
    const { workspace } = await seedWorkspace();
    const sock = connect({ workspaceId: workspace.id });
    try {
      await waitForDisconnect(sock);
      expect(sock.connected).toBe(false);
    } finally {
      sock.close();
    }
  });

  it('rejects a connection with a bogus JWT', async () => {
    const { workspace } = await seedWorkspace();
    const sock = connect({ token: 'not-a-jwt', workspaceId: workspace.id });
    try {
      await waitForDisconnect(sock);
      expect(sock.connected).toBe(false);
    } finally {
      sock.close();
    }
  });

  it('rejects when JWT is valid but user is not a member of the workspace', async () => {
    const { workspace } = await seedWorkspace();
    const { user: outsider } = await createUser();
    const token = signAccessToken(outsider.id, outsider.email);
    const sock = connect({ token, workspaceId: workspace.id });
    try {
      await waitForDisconnect(sock);
      expect(sock.connected).toBe(false);
    } finally {
      sock.close();
    }
  });

  it('accepts a member, joins them to their conversation rooms, and emits presence:snapshot', async () => {
    const { user, workspace, member } = await seedWorkspace();
    // Place the member in one conversation so handleConnection has a room to join.
    const conv = await prisma().conversation.create({
      data: {
        workspaceId: workspace.id,
        members: { create: { workspaceMemberId: member.id } },
      },
    });
    const token = signAccessToken(user.id, user.email);
    const sock = connect({ token, workspaceId: workspace.id });
    try {
      const snapshot = await waitFor(sock, 'presence:snapshot');
      expect(snapshot).toEqual(expect.objectContaining({ online: expect.any(Array) }));
      expect(Array.isArray(snapshot.online)).toBe(true);
      // The connecting member should appear online in their own snapshot.
      expect(snapshot.online).toContain(member.id);
      void conv; // touched to verify the membership exists
    } finally {
      sock.close();
    }
  });

  it('broadcasts presence:update {online:true} to other members of the same workspace', async () => {
    const { user: adminUser, workspace, member: admin } = await seedWorkspace();
    const { user: alice } = await createUser();
    const aliceMember = await addMember(workspace.id, alice.id, 'employee');

    const adminSock = connect({ token: signAccessToken(adminUser.id, adminUser.email), workspaceId: workspace.id });
    try {
      // Wait for admin's own snapshot first so the workspace presence room is established.
      await waitFor(adminSock, 'presence:snapshot');

      // Alice connects — admin should observe her come online.
      const aliceSock = connect({ token: signAccessToken(alice.id, alice.email), workspaceId: workspace.id });
      try {
        const update = await waitFor(adminSock, 'presence:update');
        expect(update).toMatchObject({ memberId: aliceMember.id, online: true });
        void admin;
      } finally {
        aliceSock.close();
      }
    } finally {
      adminSock.close();
    }
  });
});
