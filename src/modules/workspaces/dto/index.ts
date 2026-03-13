import { IsString, IsNotEmpty, MaxLength, IsOptional, IsEnum, IsUUID, IsObject } from 'class-validator';

export class CreateWorkspaceDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name: string = '';
}

export class UpdateWorkspaceDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsObject() settings?: any;
}

export class InviteMemberDto {
  @IsString() email: string = '';
  @IsString() role: string = 'employee';
  @IsOptional() @IsUUID() managerId?: string;
}

export class UpdateMemberDto {
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsUUID() managerId?: string | null;
  @IsOptional() @IsString() timezone?: string;
}
