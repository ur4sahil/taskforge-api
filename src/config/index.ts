import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  apiUrl: process.env.API_URL || 'http://localhost:3001',
  inboundEmailDomain: process.env.INBOUND_EMAIL_DOMAIN || 'inbound.taskforge.io',
}));

export const authConfig = registerAs('auth', () => ({
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL,
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID,
  microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  microsoftCallbackUrl: process.env.MICROSOFT_CALLBACK_URL,
  bcryptRounds: 12,
  refreshTokenDays: 7,
}));

export const redisConfig = registerAs('redis', () => ({
  // Points to local Redis on Oracle VM by default
  url: process.env.REDIS_URL || 'redis://localhost:6379',
}));

export const storageConfig = registerAs('storage', () => ({
  r2AccountId: process.env.R2_ACCOUNT_ID,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  r2BucketName: process.env.R2_BUCKET_NAME || 'taskforge-files',
  r2Endpoint: process.env.R2_ENDPOINT,
}));

export const aiConfig = registerAs('ai', () => ({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
  maxTokens: 4096,
}));
