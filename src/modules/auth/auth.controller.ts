import { Controller, Post, Get, Body, Param, Req, Res, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { SignupDto, LoginDto, RefreshTokenDto, ForgotPasswordDto, ResetPasswordDto, ChangePasswordDto } from './dto';
import { CurrentUser, Public } from '../../common/decorators';
import { successResponse } from '../../common/dto/response.dto';
import { AUTH_THROTTLE, REFRESH_THROTTLE } from '../../common/throttle.config';

// 5/min/ip on credential endpoints — overrides the 600/min default bucket.
const AUTH_RATE = AUTH_THROTTLE;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Public()
  @Throttle(AUTH_RATE)
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    return successResponse(await this.auth.signup(dto, req.ip, req.headers['user-agent'] as string));
  }

  @Public()
  @Throttle(AUTH_RATE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return successResponse(await this.auth.login(dto, req.ip, req.headers['user-agent'] as string));
  }

  @Public()
  @Throttle(REFRESH_THROTTLE)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return successResponse(await this.auth.refresh(dto, req.ip, req.headers['user-agent'] as string));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: RefreshTokenDto, @CurrentUser() u: any) {
    await this.auth.logout(dto.refreshToken, u?.userId);
    return successResponse({ message: 'Logged out' });
  }

  // Same 200 + message whether or not the email exists — see AuthService.forgotPassword.
  @Public()
  @Throttle(AUTH_RATE)
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return successResponse(await this.auth.forgotPassword(dto.email));
  }

  // Lets the reset page render "expired / used / ok for s***l@example.com"
  // before asking for a password. Token is 256-bit so guessing is not a
  // concern; the default per-IP bucket applies.
  @Public()
  @Get('reset-password/:token')
  async previewReset(@Param('token') token: string) {
    return successResponse(await this.auth.previewPasswordReset(token));
  }

  @Public()
  @Throttle(AUTH_RATE)
  @Post('reset-password/:token')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Param('token') token: string, @Body() dto: ResetPasswordDto, @Req() req: Request) {
    return successResponse(await this.auth.resetPassword(token, dto.password, req.ip, req.headers['user-agent'] as string));
  }

  // Authenticated (global JwtAuthGuard). Returns a fresh token pair because
  // every other refresh token is revoked as part of the change.
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() u: any, @Req() req: Request) {
    return successResponse(await this.auth.changePassword(u.userId, dto, req.ip, req.headers['user-agent'] as string));
  }

  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleInit() { /* handled by passport redirect */ }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const appUrl = this.config.get<string>('app.appUrl') || 'http://localhost:3000';
    try {
      const data = await this.auth.loginWithGoogle(req.user as any, req.ip, req.headers['user-agent'] as string);
      const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
      return res.redirect(`${appUrl}/auth/callback#data=${payload}`);
    } catch (err) {
      const msg = encodeURIComponent((err as Error).message || 'Google sign-in failed');
      return res.redirect(`${appUrl}/auth/login?error=${msg}`);
    }
  }
}
