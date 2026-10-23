// Due dates are calendar dates, not instants. Task.dueDate is a Postgres DATE
// (Prisma @db.Date), which Prisma surfaces as midnight UTC of that day. "Is it
// overdue?" must therefore compare the stored day against *today in the
// workspace's timezone*, never against `new Date()` — comparing against the
// UTC instant made a task due today read as overdue from 8 pm Eastern onward.

export const DEFAULT_WORKSPACE_TIMEZONE = 'America/New_York';

/** Workspace timezone from its settings JSON, falling back to the default when
 *  unset or not a real IANA zone. */
export function workspaceTimezone(settings: unknown): string {
  const tz = (settings as any)?.timezone;
  if (typeof tz !== 'string' || !tz) return DEFAULT_WORKSPACE_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_WORKSPACE_TIMEZONE;
  }
}

/** 'YYYY-MM-DD' for the current calendar day in `tz`. */
export function todayKey(tz: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The Date value Prisma uses for a @db.Date column holding `key`
 *  (midnight UTC), suitable for where-clause comparisons. */
export function dateKeyToDb(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** 'YYYY-MM-DD' of a @db.Date value as Prisma returns it. */
export function dbDateToKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days from `dueDate` (a @db.Date value) to the calendar day `today`.
 *  Positive = overdue by that many days, 0 = due today, negative = upcoming. */
export function daysLate(dueDate: Date, today: string): number {
  return Math.round((dateKeyToDb(today).getTime() - dueDate.getTime()) / 86400000);
}
