import { IsString, IsNotEmpty, MaxLength, IsOptional, IsUUID, IsEnum, IsDateString, IsBoolean, IsArray, IsIn, Matches, ValidateIf, registerDecorator, ValidationOptions } from 'class-validator';
import { TaskStatus, TaskPriority } from '@prisma/client';

// 'HH:MM' 24-hour clock, the shape Task.dueTime / startTime are stored in (VarChar(5)).
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 'YYYY-MM-DD' calendar day — the only shape date filters accept; parsed with
// dateKeyToDb so the comparison is on calendar days in the workspace timezone.
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const TASK_SORT_FIELDS = ['createdAt', 'dueDate', 'priority', 'title', 'updatedAt'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;
// Query-string booleans. We deliberately type these as strings: class-transformer's
// implicit conversion turns the string '0' into `true`, so a typed boolean would be
// wrong for ?archived=0.
const FLAG_VALUES = ['0', '1', 'true', 'false'] as const;
export type Flag = typeof FLAG_VALUES[number];
export const isFlagOn = (v?: string) => v === '1' || v === 'true';

/** Real IANA zone, validated the same way dates.ts does (Intl throws on unknown zones). */
export function isIanaTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export function IsIanaTimezone(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'isIanaTimezone', target: object.constructor, propertyName, options,
    validator: { validate: (v: unknown) => isIanaTimezone(v), defaultMessage: () => `${propertyName} must be a valid IANA timezone` },
  });
}

/** 'YYYY-MM-DD' that is also a real calendar day (rejects 2026-02-31). */
export function isDateKey(v: unknown): boolean {
  if (typeof v !== 'string' || !DATE_KEY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function IsDateKey(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'isDateKey', target: object.constructor, propertyName, options,
    validator: { validate: (v: unknown) => isDateKey(v), defaultMessage: () => `${propertyName} must be a YYYY-MM-DD calendar date` },
  });
}

// Present-and-not-null guard for nullable fields: `null` means "clear it" and is
// accepted as-is; anything else must pass the format validators.
const notNull = (prop: string) => (o: any) => o[prop] !== undefined && o[prop] !== null;

export class CreateTaskDto {
  @IsString() @IsNotEmpty() @MaxLength(255) title: string = '';
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @Matches(TIME_RE, { message: 'startTime must be HH:MM (24h)' }) startTime?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @Matches(TIME_RE, { message: 'dueTime must be HH:MM (24h)' }) dueTime?: string;
  @IsOptional() @IsIanaTimezone() timezone?: string;
  @IsOptional() @IsUUID() parentTaskId?: string;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(TaskStatus) status?: TaskStatus;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  /** Move the task (and its subtasks) to another list in this workspace. The
   *  target must be visible to the caller under the same rule as task creation. */
  @IsOptional() @IsUUID() listId?: string;
  /** null unassigns; otherwise must be a member uuid. */
  @ValidateIf(notNull('assigneeId')) @IsUUID() assigneeId?: string | null;
  @IsOptional() @IsDateString() startDate?: string | null;
  @IsOptional() @IsDateString() dueDate?: string | null;
  @ValidateIf(notNull('startTime')) @Matches(TIME_RE, { message: 'startTime must be HH:MM (24h)' }) startTime?: string | null;
  @ValidateIf(notNull('dueTime')) @Matches(TIME_RE, { message: 'dueTime must be HH:MM (24h)' }) dueTime?: string | null;
  @ValidateIf(notNull('timezone')) @IsIanaTimezone() timezone?: string | null;
}

export class TaskFilterDto {
  @IsOptional() @IsEnum(TaskStatus) status?: TaskStatus;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsUUID() creatorId?: string;
  @IsOptional() @IsUUID() listId?: string;
  /** Inclusive calendar-day bounds on dueDate. */
  @IsOptional() @IsDateKey() dueFrom?: string;
  @IsOptional() @IsDateKey() dueTo?: string;
  /** dueDate before today (workspace timezone) AND status != done. */
  @IsOptional() @IsIn(FLAG_VALUES) overdue?: Flag;
  /** assigneeId = the caller's member id. */
  @IsOptional() @IsIn(FLAG_VALUES) mine?: Flag;
  /** List archived tasks (archivedAt set) instead of live ones. */
  @IsOptional() @IsIn(FLAG_VALUES) archived?: Flag;
  /** Case-insensitive substring on title or description. */
  @IsOptional() @IsString() @MaxLength(255) q?: string;
  @IsOptional() @IsIn(TASK_SORT_FIELDS) sortBy?: typeof TASK_SORT_FIELDS[number];
  @IsOptional() @IsIn(SORT_ORDERS) sortOrder?: typeof SORT_ORDERS[number];
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
