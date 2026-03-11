import { IsString, IsNotEmpty, MaxLength, IsOptional, IsEmail, IsEnum, IsUUID, IsObject } from 'class-validator';
import { WorkspaceRole } from '@prisma/client';
export class CreateWorkspaceDto { @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; }
export class UpdateWorkspaceDto { @IsOptional() @IsString() @MaxLength(255) name?: string; @IsOptional() @IsObject() settings?: Record<string, unknown>; }
export class InviteMemberDto { @IsEmail() email: string = ''; @IsEnum(WorkspaceRole) role: WorkspaceRole = 'employee'; @IsOptional() @IsUUID() managerId?: string; }
export class UpdateMemberDto { @IsOptional() @IsEnum(WorkspaceRole) role?: WorkspaceRole; @IsOptional() @IsUUID() managerId?: string | null; @IsOptional() @IsString() timezone?: string; }
