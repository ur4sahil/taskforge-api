import {
  IsInt, IsOptional, IsArray, IsBoolean, IsEnum, IsIn, Min, Max, ArrayMaxSize,
  ValidateIf, registerDecorator, ValidationOptions,
} from 'class-validator';
import { RecurrenceFrequency, RecurrenceEndType } from '@prisma/client';

export const REPEAT_DELAY_UNITS = ['days', 'weeks', 'months', 'years'] as const;

// Local copies of the tasks DTO validators so this module does not depend on a
// file another engineer is editing concurrently.
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDateKey(v: unknown): boolean {
  if (typeof v !== 'string' || !DATE_KEY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function IsDateKey(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'isDateKey', target: object.constructor, propertyName, options,
    validator: { validate: (v: unknown) => isDateKey(v), defaultMessage: () => `${propertyName} must be a YYYY-MM-DD calendar date` },
  });
}
function isIanaTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function IsIanaTimezone(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'isIanaTimezone', target: object.constructor, propertyName, options,
    validator: { validate: (v: unknown) => isIanaTimezone(v), defaultMessage: () => `${propertyName} must be a valid IANA timezone` },
  });
}

export class CreateRecurrenceDto {
  @IsEnum(RecurrenceFrequency) frequency: RecurrenceFrequency = 'weekly';
  @IsOptional() @IsInt() @Min(1) @Max(365) interval?: number;
  /** 0 = Sunday .. 6 = Saturday. Weekly/custom only. */
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[];
  /** 1..31; clamped to short months at generation time. Monthly/custom only. */
  @IsOptional() @IsInt() @Min(1) @Max(31) dayOfMonth?: number;
  @IsOptional() @IsEnum(RecurrenceEndType) endType?: RecurrenceEndType;
  /** Total occurrences including the source task. Required when endType = after_count. */
  @ValidateIf(o => o.endType === 'after_count') @IsInt() @Min(1) endCount?: number;
  /** Inclusive last day, 'YYYY-MM-DD'. Required when endType = on_date. */
  @ValidateIf(o => o.endType === 'on_date') @IsDateKey() endDate?: string;
  @IsOptional() @IsIanaTimezone() timezone?: string;
  @IsOptional() @IsBoolean() repeatAfterCompletion?: boolean;
  @IsOptional() @IsInt() @Min(0) repeatDelayValue?: number;
  @IsOptional() @IsIn(REPEAT_DELAY_UNITS) repeatDelayUnit?: string;
}

export class UpdateRecurrenceDto {
  @IsOptional() @IsEnum(RecurrenceFrequency) frequency?: RecurrenceFrequency;
  @IsOptional() @IsInt() @Min(1) @Max(365) interval?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[];
  @IsOptional() @IsInt() @Min(1) @Max(31) dayOfMonth?: number | null;
  @IsOptional() @IsEnum(RecurrenceEndType) endType?: RecurrenceEndType;
  @IsOptional() @IsInt() @Min(1) endCount?: number | null;
  @IsOptional() @IsDateKey() endDate?: string | null;
  @IsOptional() @IsIanaTimezone() timezone?: string;
  @IsOptional() @IsBoolean() repeatAfterCompletion?: boolean;
  @IsOptional() @IsInt() @Min(0) repeatDelayValue?: number | null;
  @IsOptional() @IsIn(REPEAT_DELAY_UNITS) repeatDelayUnit?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
