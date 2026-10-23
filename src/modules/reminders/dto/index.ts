import { IsString, IsOptional, IsDateString, IsInt, IsEnum, IsIn, Min, ValidateIf } from 'class-validator';
import { ReminderType } from '@prisma/client';

export const RELATIVE_OFFSET_UNITS = ['minutes', 'hours', 'days'] as const;
export type RelativeOffsetUnit = typeof RELATIVE_OFFSET_UNITS[number];

export class CreateReminderDto {
  @IsEnum(ReminderType) type: ReminderType = 'exact';
  /** Required for type = exact. */
  @ValidateIf(o => o.type === 'exact') @IsDateString() exactTime?: string;
  /** Required for type = relative: fire this far before the task's due time. */
  @ValidateIf(o => o.type === 'relative') @IsInt() @Min(0) relativeOffsetValue?: number;
  @ValidateIf(o => o.type === 'relative') @IsIn(RELATIVE_OFFSET_UNITS) relativeOffsetUnit?: RelativeOffsetUnit;
}

export class UpdateReminderDto {
  @IsOptional() @IsDateString() exactTime?: string;
  @IsOptional() @IsInt() @Min(0) relativeOffsetValue?: number;
  @IsOptional() @IsIn(RELATIVE_OFFSET_UNITS) relativeOffsetUnit?: RelativeOffsetUnit;
}

export class SnoozeDto {
  @IsOptional() @IsDateString() until?: string;
  @IsOptional() @IsString() duration?: string;
}
