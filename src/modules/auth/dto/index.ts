import { applyDecorators } from '@nestjs/common';
import { IsEmail, IsString, MinLength, MaxLength, IsNotEmpty } from 'class-validator';

/** The one password rule for the whole API: signup, reset and change all
 *  validate against this so the policy can't drift between flows. */
export const PasswordRules = () => applyDecorators(IsString(), MinLength(8), MaxLength(128));

export class SignupDto {
  @IsEmail() email: string = '';
  @PasswordRules() password: string = '';
  @IsString() @IsNotEmpty() @MaxLength(255) name: string = '';
}

export class LoginDto {
  @IsEmail() email: string = '';
  @IsString() password: string = '';
}

export class RefreshTokenDto {
  @IsString() @IsNotEmpty() refreshToken: string = '';
}

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(255) email: string = '';
}

export class ResetPasswordDto {
  @PasswordRules() password: string = '';
}

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() currentPassword: string = '';
  @PasswordRules() newPassword: string = '';
}
