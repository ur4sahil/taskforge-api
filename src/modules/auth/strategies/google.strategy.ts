import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, StrategyOptions } from 'passport-google-oauth20';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    const clientID = config.get<string>('auth.googleClientId');
    const clientSecret = config.get<string>('auth.googleClientSecret');
    if (!clientID || !clientSecret) {
      throw new Error('Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)');
    }
    super({
      clientID,
      clientSecret,
      callbackURL: config.get<string>('auth.googleCallbackUrl')!,
      scope: ['email', 'profile'],
    } as StrategyOptions);
  }

  async validate(_at: string, _rt: string, profile: any) {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    if (!email) throw new UnauthorizedException('Google account has no email');
    return {
      email,
      name: profile.displayName || email.split('@')[0],
      avatarUrl: profile.photos?.[0]?.value || null,
      googleId: profile.id,
    };
  }
}
