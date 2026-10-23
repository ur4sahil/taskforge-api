import {
  Body, Controller, Get, Injectable, Module, NotFoundException, Patch,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../../common/decorators';
import { successResponse } from '../../common/dto/response.dto';

// ───── DTOs ──────────────────────────────────────────────────────────────────

export class UpdateMeDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MinLength(1) @MaxLength(100) name: string = '';
}

// ───── Service ───────────────────────────────────────────────────────────────

const PROFILE_SELECT = { id: true, email: true, name: true, authProvider: true, createdAt: true } as const;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async me(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    await this.me(userId);
    return this.prisma.user.update({ where: { id: userId }, data: { name: dto.name }, select: PROFILE_SELECT });
  }
}

// ───── Controller (JwtAuthGuard is global; no workspace context needed) ──────

@Controller('users')
export class UsersController {
  constructor(private svc: UsersService) {}

  @Get('me')
  async me(@CurrentUser() u: any) {
    return successResponse(await this.svc.me(u.userId));
  }

  @Patch('me')
  async updateMe(@CurrentUser() u: any, @Body() dto: UpdateMeDto) {
    return successResponse(await this.svc.updateMe(u.userId, dto));
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
