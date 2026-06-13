// Unit tests for PushService.sendTo — the web-push send + stale-subscription
// pruning logic. web-push is mocked at the module level so nothing leaves the
// process; Prisma is a hand-rolled fake so we can assert prune deletes.
import { ConfigService } from '@nestjs/config';

const setVapidDetailsMock = jest.fn();
const sendNotificationMock = jest.fn();
jest.mock('web-push', () => ({
  setVapidDetails: (...a: any[]) => setVapidDetailsMock(...a),
  sendNotification: (...a: any[]) => sendNotificationMock(...a),
}));

import { PushService } from '../../src/modules/push/push.module';

function makeConfig(withVapid: boolean): ConfigService {
  const base: Record<string, any> = withVapid
    ? { 'push.vapidPublic': 'pub', 'push.vapidPrivate': 'priv', 'push.vapidSubject': 'mailto:x@y.z' }
    : { 'push.vapidPublic': '', 'push.vapidPrivate': '', 'push.vapidSubject': '' };
  return { get: (k: string) => base[k] } as any;
}

function makePrisma(subs: any[]) {
  const deleted: any[] = [];
  return {
    deleted,
    pushSubscription: {
      findMany: jest.fn().mockResolvedValue(subs),
      deleteMany: jest.fn().mockImplementation(({ where }: any) => { deleted.push(where); return Promise.resolve({ count: 1 }); }),
    },
  };
}

beforeEach(() => { setVapidDetailsMock.mockReset(); sendNotificationMock.mockReset(); });

describe('PushService.sendTo', () => {
  it('configures VAPID on init when keys are present', () => {
    const svc = new PushService(makePrisma([]) as any, makeConfig(true));
    svc.onModuleInit();
    expect(setVapidDetailsMock).toHaveBeenCalledWith('mailto:x@y.z', 'pub', 'priv');
  });

  it('no-ops when VAPID is not configured', async () => {
    const svc = new PushService(makePrisma([{ endpoint: 'e' }]) as any, makeConfig(false));
    svc.onModuleInit();
    await svc.sendTo('m1', { title: 't', body: 'b' });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('sends one push per subscription the member has', async () => {
    const prisma = makePrisma([
      { endpoint: 'https://a', p256dh: 'pa', authKey: 'aa' },
      { endpoint: 'https://b', p256dh: 'pb', authKey: 'ab' },
    ]);
    sendNotificationMock.mockResolvedValue({});
    const svc = new PushService(prisma as any, makeConfig(true));
    svc.onModuleInit();
    await svc.sendTo('m1', { title: 't', body: 'b' });
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    expect(prisma.deleted).toHaveLength(0);
  });

  it('prunes subscriptions that return 410 Gone', async () => {
    const prisma = makePrisma([
      { endpoint: 'https://gone', p256dh: 'p', authKey: 'a' },
      { endpoint: 'https://ok', p256dh: 'p', authKey: 'a' },
    ]);
    sendNotificationMock.mockImplementation((subInfo: any) => {
      if (subInfo.endpoint === 'https://gone') return Promise.reject({ statusCode: 410 });
      return Promise.resolve({});
    });
    const svc = new PushService(prisma as any, makeConfig(true));
    svc.onModuleInit();
    await svc.sendTo('m1', { title: 't', body: 'b' });
    expect(prisma.deleted).toEqual([{ endpoint: { in: ['https://gone'] } }]);
  });

  it('does NOT prune on a transient (500) send failure', async () => {
    const prisma = makePrisma([{ endpoint: 'https://flaky', p256dh: 'p', authKey: 'a' }]);
    sendNotificationMock.mockRejectedValue({ statusCode: 500, message: 'server error' });
    const svc = new PushService(prisma as any, makeConfig(true));
    svc.onModuleInit();
    await svc.sendTo('m1', { title: 't', body: 'b' });
    expect(prisma.deleted).toHaveLength(0);
  });

  it('high urgency sets a short TTL on the send options', async () => {
    const prisma = makePrisma([{ endpoint: 'https://a', p256dh: 'p', authKey: 'a' }]);
    sendNotificationMock.mockResolvedValue({});
    const svc = new PushService(prisma as any, makeConfig(true));
    svc.onModuleInit();
    await svc.sendTo('m1', { title: 't', body: 'b' }, 'high');
    const opts = sendNotificationMock.mock.calls[0][2];
    expect(opts).toMatchObject({ urgency: 'high', TTL: 30 });
  });
});
