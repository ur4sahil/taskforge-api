import { IsString, IsNotEmpty, MaxLength, IsOptional, IsEnum, IsUUID, IsObject } from 'class-validator';

export class CreateWorkspaceDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name: string = '';
}

export class UpdateWorkspaceDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsObject() settings?: any;
}

export class InviteMemberDto {
  @IsString() @IsNotEmpty() @MaxLength(255) email: string = '';
  @IsString() @IsNotEmpty() @MaxLength(100) name: string = '';
  @IsOptional() @IsEnum(['admin', 'manager', 'employee'] as any) role?: 'admin' | 'manager' | 'employee';
  @IsOptional() @IsUUID() managerId?: string;
}

export class UpdateMemberDto {
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsUUID() managerId?: string | null;
  @IsOptional() @IsString() timezone?: string;
}
