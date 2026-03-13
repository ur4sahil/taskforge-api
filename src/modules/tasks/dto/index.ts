import { IsString, IsNotEmpty, MaxLength, IsOptional, IsUUID, IsEnum, IsDateString, IsBoolean, IsArray } from 'class-validator';

export class CreateTaskDto {
  @IsString() @IsNotEmpty() @MaxLength(255) title: string = '';
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() dueTime?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsUUID() parentTaskId?: string;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() assigneeId?: string | null;
  @IsOptional() @IsDateString() startDate?: string | null;
  @IsOptional() @IsDateString() dueDate?: string | null;
}

export class TaskFilterDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsString() sortBy?: string;
  @IsOptional() @IsString() sortOrder?: string;
}

export class CreateChecklistItemDto {
  @IsString() @IsNotEmpty() @MaxLength(500) text: string = '';
}

export class UpdateChecklistItemDto {
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @IsBoolean() isChecked?: boolean;
}

export class ReorderChecklistDto {
  @IsArray() itemIds: string[] = [];
}
