import { ThrottlerModuleOptions } from '@nestjs/throttler';

// Rate-limit configuration, shared by app.module (registration) and the
// per-route overrides below.
//
// ONE named throttler only. @nestjs/throttler applies EVERY throttler in the
// forRoot array to EVERY route (ThrottlerGuard loops over them), so a second
// "auth" bucket at 5/min was being enforced on all traffic — the Home page's
// 4-6 parallel loads alone tripped it on every visit. Tight limits for
// credential endpoints are expressed instead as a route-level override of the
// `default` bucket (see AUTH_THROTTLE), which replaces the 600 limit for just
// that handler.
//
// The default bucket is high (600/min) because each user gets their own
// bucket via UserAwareThrottlerGuard (per-userId for authenticated routes,
// per-IP otherwise). An iOS PWA actively navigating + WebSocket fallback +
// periodic background fetches comfortably bursts 60-80 req/min for a single
// user, and the previous 100/min limit produced 429s on normal use.
//
// Skip conditions:
//   1. NODE_ENV=test — keeps the in-memory tracker from carrying state
//      across the API's own jest suite (auth.spec.ts hits /signup 9x).
//   2. `x-bypass-throttle` request header matching env.THROTTLE_BYPASS_SECRET
//      — lets the E2E suite (which legitimately creates many ephemeral users
//      against live prod) skip throttling without weakening real-world
//      brute-force protection. The secret is set on the VPS .env and
//      mirrored in Playwright's env at run time.
export function shouldSkipThrottle(ctx: any): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  const secret = process.env.THROTTLE_BYPASS_SECRET;
  if (!secret) return false;
  // ThrottlerGuard passes its ExecutionContext; for the HTTP path, switchToHttp()
  // exposes the request whose headers carry the bypass token.
  try {
    const req = ctx?.switchToHttp?.()?.getRequest?.();
    const header = req?.headers?.['x-bypass-throttle'];
    return typeof header === 'string' && header === secret;
  } catch {
    return false;
  }
}

export const DEFAULT_THROTTLE_LIMIT = 600;
export const DEFAULT_THROTTLE_TTL = 60_000;

export const THROTTLERS: ThrottlerModuleOptions = [
  { name: 'default', ttl: DEFAULT_THROTTLE_TTL, limit: DEFAULT_THROTTLE_LIMIT, skipIf: shouldSkipThrottle },
];

// Tight rate-limit for credential endpoints (signup / login / forgot-password /
// invitation accept) — 5/min/ip. These are @Public, so the guard keys them by
// IP; without this, brute-forcing a password or invite token would get 600
// attempts/min. Use as `@Throttle(AUTH_THROTTLE)` on the handler.
export const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

// /auth/refresh gets its own, looser override. Every open tab and device
// refreshes every 15 minutes, and staff in one office share one IP — at 5/min
// a handful of people refreshing together 429'd each other, and a client whose
// refresh was refused logged the user out. The token being presented is 80
// random hex chars, so a higher limit buys an attacker nothing.
export const REFRESH_THROTTLE = { default: { limit: 30, ttl: 60_000 } };
