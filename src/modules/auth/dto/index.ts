// ═══ src/modules/auth/dto/index.ts ═══
import { IsEmail, IsString, MinLength, MaxLength, IsNotEmpty } from 'class-validator';

export class SignupDto {
  @IsEmail() email: string = '';
  @IsString() @MinLength(8) @MaxLength(128) password: string = '';
  @IsString() @IsNotEmpty() @MaxLength(255) name: string = '';
}

export class LoginDto {
  @IsEmail() email: string = '';
  @IsString() password: string = '';
}

export class RefreshTokenDto {
  @IsString() @IsNotEmpty() refreshToken: string = '';
}

export class ForgotPasswordDto { @IsEmail() email: string = ''; }

export class ResetPasswordDto {
  @IsString() @IsNotEmpty() token: string = '';
  @IsString() @MinLength(8) @MaxLength(128) password: string = '';
}

export interface AuthTokens { accessToken: string; refreshToken: string; }
export interface AuthResponse extends AuthTokens {
  user: { id: string; email: string; name: string; avatarUrl: string | null; authProvider: string };
  workspaces: Array<{ id: string; name: string; slug: string; role: string }>;
}
