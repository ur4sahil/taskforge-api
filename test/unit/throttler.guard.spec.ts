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

  it('keys anonymous requests on CF-Connecting-IP (set by Cloudflare, not spoofable through the tunnel)', async () => {
    expect(await tracker({ headers: { 'cf-connecting-ip': '203.0.113.7' }, ip: '127.0.0.1' })).toBe('ip:203.0.113.7');
  });

  it('ignores a client-supplied X-Forwarded-For — one header per request used to reset the login limit', async () => {
    const key = await tracker({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, ip: '198.51.100.2' });
    expect(key).toBe('ip:198.51.100.2');
  });

  it('uses req.ip (Express trust-proxy resolved) when there is no CF header', async () => {
    expect(await tracker({ headers: {}, ip: '198.51.100.2' })).toBe('ip:198.51.100.2');
  });

  it('treats a blank CF header as absent', async () => {
    expect(await tracker({ headers: { 'cf-connecting-ip': '  ' }, ip: '198.51.100.2' })).toBe('ip:198.51.100.2');
  });

  it('returns ip:unknown when neither user, forwarded header, nor ip is available', async () => {
    expect(await tracker({ headers: {} })).toBe('ip:unknown');
  });
});
