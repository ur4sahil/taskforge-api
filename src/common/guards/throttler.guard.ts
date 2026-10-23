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
    // Fall back to IP. Cloudflare sets CF-Connecting-IP to the true client
    // address and overwrites any value the client sent, so it can't be spoofed
    // through the tunnel. req.ip is the Express-resolved address under
    // `trust proxy` (see main.ts). The old code took the *first* X-Forwarded-For
    // hop, which is whatever the client typed — one header per request defeated
    // the 5/min login limit entirely.
    const cf = req.headers?.['cf-connecting-ip'];
    const ip = (typeof cf === 'string' && cf.trim()) || req.ip || 'unknown';
    return `ip:${ip}`;
  }
}
