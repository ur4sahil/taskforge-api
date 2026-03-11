import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.registerAsync({ useFactory: (c: ConfigService) => ({ secret: c.get('auth.jwtAccessSecret'), signOptions: { expiresIn: c.get('auth.jwtAccessExpiry') || '15m' } }), inject: [ConfigService] })],
  controllers: [AuthController], providers: [AuthService, JwtStrategy], exports: [AuthService, JwtModule],
})
export class AuthModule {}
