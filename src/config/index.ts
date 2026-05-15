import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  apiUrl: process.env.API_URL || 'http://localhost:3001',
  inboundEmailDomain: process.env.INBOUND_EMAIL_DOMAIN || 'inbound.taskforge.io',
  inboundWebhookSecret: process.env.INBOUND_WEBHOOK_SECRET || '',
}));

export const pushConfig = registerAs('push', () => ({
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:noreply@taskforge.local',
}));

function requireSecret(name: string, fallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    // A misconfigured deploy that quietly falls back to 'dev-access-secret'
    // would let anyone forge JWTs. Better to crash on boot than ship insecure.
    throw new Error(`${name} is required in production`);
  }
  return fallback;
}

export const authConfig = registerAs('auth', () => ({
  jwtAccessSecret: requireSecret('JWT_ACCESS_SECRET', 'dev-access-secret'),
  jwtRefreshSecret: requireSecret('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  bcryptRounds: 12,
  refreshTokenDays: 7,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/v1/auth/google/callback',
}));

export const redisConfig = registerAs('redis', () => ({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
}));

export const storageConfig = registerAs('storage', () => ({
  r2BucketName: process.env.R2_BUCKET_NAME || 'taskforge-files',
  r2AccountId: process.env.R2_ACCOUNT_ID,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  r2PublicUrl: process.env.R2_PUBLIC_URL,
  // Optional prefix prepended to every key. Used when sharing a bucket with another
  // app (e.g. FlipRadar's flipradar-photos bucket). Empty = no prefix.
  r2KeyPrefix: process.env.R2_KEY_PREFIX || '',
  presignedUrlExpirySeconds: parseInt(process.env.R2_URL_TTL || '3600', 10),
}));

export const aiConfig = registerAs('ai', () => ({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
}));
