// JWT helpers — mint access tokens directly to avoid login round-trips when a
// test just needs an authenticated request.
import { JwtService } from '@nestjs/jwt';

const jwt = new JwtService({});

export function signAccessToken(userId: string, email: string, name = 'Test User') {
  return jwt.sign(
    { sub: userId, userId, email, name },
    { secret: process.env.JWT_ACCESS_SECRET!, expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m' },
  );
}

export function authHeader(userId: string, email: string) {
  return { Authorization: `Bearer ${signAccessToken(userId, email)}` };
}
