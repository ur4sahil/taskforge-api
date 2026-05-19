import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Per-user throttling for authenticated requests, per-IP otherwise.
 *
 *  The default ThrottlerGuard tracks every requester by IP. That breaks for
 *  teams: two employees behind the same office NAT (or two iOS PWAs on the
 *  same household Wi-Fi) share one bucket and the second user starts seeing
 *  429s after the first does ~half of their normal work.
 *
 *  By keying on the authenticated user id, each user gets their own budget;
 *  unauthenticated routes (login/signup) still fall back to IP so brute-force
 *  protection on those endpoints doesn't degrade. */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req?.user?.userId;
    if (userId) return `user:${userId}`;
    // Fall back to IP. Honor X-Forwarded-For (we sit behind cloudflared).
    const fwd = req.headers?.['x-forwarded-for'];
    const ip = (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : null) || req.ip || 'unknown';
    return `ip:${ip}`;
  }
}
