import { IsString, IsNotEmpty, MaxLength, IsOptional, IsUUID, IsObject } from 'class-validator';

export class CreateWorkspaceDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name: string = '';
}

export class UpdateWorkspaceDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsObject() settings?: any;
}

export class UpdateMemberDto {
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsUUID() managerId?: string | null;
  @IsOptional() @IsString() timezone?: string;
}

/** What a member may change about their own membership. IANA validity is
 *  checked in the service (class-validator has no timezone rule). */
export class UpdateOwnMemberDto {
  @IsString() @IsNotEmpty() @MaxLength(50) timezone: string = '';
}
