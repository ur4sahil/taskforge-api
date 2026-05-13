import { Controller, Post, Get, Body, Req, Res, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { SignupDto, LoginDto, RefreshTokenDto } from './dto';
import { Public } from '../../common/decorators';
import { successResponse } from '../../common/dto/response.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Public()
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    return successResponse(await this.auth.signup(dto, req.ip, req.headers['user-agent'] as string));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return successResponse(await this.auth.login(dto, req.ip, req.headers['user-agent'] as string));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return successResponse(await this.auth.refresh(dto, req.ip, req.headers['user-agent'] as string));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: RefreshTokenDto) {
    await this.auth.logout(dto.refreshToken);
    return successResponse({ message: 'Logged out' });
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
