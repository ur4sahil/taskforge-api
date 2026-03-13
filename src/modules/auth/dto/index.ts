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
