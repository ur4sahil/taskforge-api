// Unit tests for UserAwareThrottlerGuard.getTracker — the per-user vs per-IP
// bucket key derivation. getTracker is protected, so we reach it through a thin
// subclass. The base ThrottlerGuard needs constructor deps we don't exercise
// here, so we instantiate via Object.create and call the method directly.
import { UserAwareThrottlerGuard } from '../../src/common/guards/throttler.guard';

function tracker(req: any): Promise<string> {
  const guard: any = Object.create(UserAwareThrottlerGuard.prototype);
  return guard.getTracker(req);
}

describe('UserAwareThrottlerGuard.getTracker', () => {
  it('keys on the authenticated user id when present', async () => {
    expect(await tracker({ user: { userId: 'u-123' }, ip: '1.2.3.4' })).toBe('user:u-123');
  });

  it('falls back to the first X-Forwarded-For hop for anonymous requests', async () => {
    expect(await tracker({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '10.0.0.1' })).toBe('ip:203.0.113.7');
  });

  it('uses req.ip when there is no forwarded header', async () => {
    expect(await tracker({ headers: {}, ip: '198.51.100.2' })).toBe('ip:198.51.100.2');
  });

  it('returns ip:unknown when neither user, forwarded header, nor ip is available', async () => {
    expect(await tracker({ headers: {} })).toBe('ip:unknown');
  });
});
