import { IsString, IsNotEmpty, MaxLength, IsOptional, IsUUID, IsBoolean, IsObject } from 'class-validator';
export class CreateListDto { @IsString() @IsNotEmpty() @MaxLength(255) name: string = ''; @IsOptional() @IsString() description?: string; @IsOptional() @IsUUID() defaultAssigneeId?: string; }
export class UpdateListDto { @IsOptional() @IsString() @MaxLength(255) name?: string; @IsOptional() @IsString() description?: string; @IsOptional() @IsUUID() defaultAssigneeId?: string | null; @IsOptional() @IsBoolean() inboundEmailEnabled?: boolean; }
export class AddListMemberDto { @IsUUID() workspaceMemberId: string = ''; }
