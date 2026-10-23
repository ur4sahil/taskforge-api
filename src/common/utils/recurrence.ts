// Recurrence engine. Pure functions over calendar days ('YYYY-MM-DD' keys).
//
// Due dates are calendar days in the workspace timezone (see dates.ts), so the
// engine never does instant arithmetic: a day key is converted to a proleptic
// Gregorian day number (via Date.UTC, which has no DST) and back. Crossing a
// DST change in America/New_York therefore cannot shift an occurrence onto the
// wrong day — there are no local-time instants anywhere in here.
//
// Rules the brief left open, decided here:
//  - Anchor: the schedule counts from the source task's dueDate day; when the
//    task has no dueDate, from its createdAt day in the rule's timezone. The
//    anchor is itself occurrence #1 (the source task), never generated again.
//  - Weekly intervals count Sunday-start weeks from the anchor's week, matching
//    daysOfWeek's 0=Sun..6=Sat convention. Empty daysOfWeek = the anchor's weekday.
//  - Monthly: dayOfMonth (default: anchor's day) is clamped to the last day of
//    short months and never drifts (Jan 31 → Feb 28 → Mar 31).
//  - Yearly: anchor month/day; Feb 29 is clamped to Feb 28 in non-leap years.
//  - after_count: endCount is the total number of occurrences including the
//    source task, so a rule "after 3" generates 2 instances.
//  - on_date: endDate is inclusive.
//  - repeatAfterCompletion: the next occurrence is the completion day plus the
//    delay (repeatDelayValue/Unit when present, else one interval of the rule's
//    frequency). Weekly rules ignore daysOfWeek in this mode.
//  - 'custom' frequency falls back to weekly when daysOfWeek is set, monthly
//    when dayOfMonth is set, else daily.

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export type RecurrenceEndType = 'never' | 'after_count' | 'on_date';
export type DayKey = string; // 'YYYY-MM-DD'

export interface RecurrenceSpec {
  frequency: RecurrenceFrequency | string;
  interval: number;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  endType?: RecurrenceEndType | string | null;
  endCount?: number | null;
  /** Inclusive last day. Accepts a day key or the Prisma @db.Date value. */
  endDate?: DayKey | Date | null;
  repeatAfterCompletion?: boolean | null;
  repeatDelayValue?: number | null;
  repeatDelayUnit?: string | null;
  /** Day of the source task (occurrence #1). See header. */
  anchor: DayKey;
  /** Instances already generated for this rule (excludes the source task). */
  generatedCount?: number;
}

const DAY_MS = 86_400_000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------- day keys

export function parseKey(key: DayKey): { y: number; m: number; d: number } {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Invalid day key: ${key}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function makeKey(y: number, m: number, d: number): DayKey {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days since 1970-01-01 (proleptic Gregorian, no timezone involved). */
export function keyToDayNumber(key: DayKey): number {
  const { y, m, d } = parseKey(key);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function dayNumberToKey(n: number): DayKey {
  const dt = new Date(n * DAY_MS);
  return makeKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(key: DayKey, days: number): DayKey {
  return dayNumberToKey(keyToDayNumber(key) + days);
}

/** 0 = Sunday .. 6 = Saturday. */
export function weekday(key: DayKey): number {
  // 1970-01-01 was a Thursday (4).
  return (((keyToDayNumber(key) + 4) % 7) + 7) % 7;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Add whole months, clamping the day to the target month's length. */
export function addMonthsClamped(key: DayKey, months: number, preferredDay?: number): DayKey {
  const { y, m, d } = parseKey(key);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const want = preferredDay ?? d;
  return makeKey(ny, nm, Math.min(want, daysInMonth(ny, nm)));
}

/** Add whole years, clamping Feb 29 to Feb 28 in non-leap years. */
export function addYearsClamped(key: DayKey, years: number): DayKey {
  const { y, m, d } = parseKey(key);
  const ny = y + years;
  return makeKey(ny, m, Math.min(d, daysInMonth(ny, m)));
}

/** Compare two day keys lexicographically (valid for zero-padded ISO keys). */
export function compareKeys(a: DayKey, b: DayKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalise an endDate (day key or Prisma @db.Date) to a day key. */
export function toDayKey(v: DayKey | Date | null | undefined): DayKey | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  if (KEY_RE.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- engine

/** Resolve the effective frequency, folding 'custom' onto a concrete one. */
export function effectiveFrequency(spec: RecurrenceSpec): 'daily' | 'weekly' | 'monthly' | 'yearly' {
  switch (spec.frequency) {
    case 'daily': case 'weekly': case 'monthly': case 'yearly':
      return spec.frequency;
    default:
      if (spec.daysOfWeek && spec.daysOfWeek.length) return 'weekly';
      if (spec.dayOfMonth) return 'monthly';
      return 'daily';
  }
}

/** Total occurrences the rule still allows including the source task;
 *  Infinity when unbounded by count. */
function instancesAllowed(spec: RecurrenceSpec): number {
  if (spec.endType !== 'after_count' || !spec.endCount || spec.endCount < 1) return Infinity;
  return Math.max(0, spec.endCount - 1); // the source task is occurrence #1
}

/** Apply the end conditions to a candidate occurrence. */
function applyEnd(spec: RecurrenceSpec, candidate: DayKey | null): DayKey | null {
  if (!candidate) return null;
  if ((spec.generatedCount ?? 0) >= instancesAllowed(spec)) return null;
  if (spec.endType === 'on_date') {
    const end = toDayKey(spec.endDate);
    if (end && compareKeys(candidate, end) > 0) return null;
  }
  return candidate;
}

function normDays(days?: number[] | null): number[] {
  const set = new Set<number>();
  for (const d of days ?? []) if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d);
  return [...set].sort((a, b) => a - b);
}

/** Start (Sunday) of the week containing `key`, as a day number. */
function weekStartNumber(key: DayKey): number {
  return keyToDayNumber(key) - weekday(key);
}

/** The first scheduled occurrence strictly after `after`, ignoring end
 *  conditions and ignoring repeatAfterCompletion. Occurrences never precede the
 *  anchor. */
export function nextScheduled(spec: RecurrenceSpec, after: DayKey): DayKey | null {
  const interval = Math.max(1, Math.floor(spec.interval || 1));
  const anchor = spec.anchor;
  // Nothing before the anchor counts; the anchor itself is the source task.
  const from = compareKeys(after, anchor) < 0 ? anchor : after;
  const fromN = keyToDayNumber(from);
  const anchorN = keyToDayNumber(anchor);

  switch (effectiveFrequency(spec)) {
    case 'daily': {
      // anchor + k*interval with k = smallest integer making it > from.
      const k = Math.floor((fromN - anchorN) / interval) + 1;
      return dayNumberToKey(anchorN + k * interval);
    }
    case 'weekly': {
      const days = normDays(spec.daysOfWeek);
      const wanted = days.length ? days : [weekday(anchor)];
      const anchorWeek = weekStartNumber(anchor);
      // Scan forward day by day; at most interval weeks + 1 week are needed.
      const limit = fromN + 7 * (interval + 1);
      for (let n = fromN + 1; n <= limit; n++) {
        const wd = (((n + 4) % 7) + 7) % 7;
        if (!wanted.includes(wd)) continue;
        const weekIdx = Math.floor((n - anchorWeek) / 7);
        if (weekIdx % interval !== 0) continue;
        return dayNumberToKey(n);
      }
      return null; // unreachable for a valid interval
    }
    case 'monthly': {
      const { y: ay, m: am, d: ad } = parseKey(anchor);
      const dom = spec.dayOfMonth && spec.dayOfMonth >= 1 && spec.dayOfMonth <= 31 ? Math.floor(spec.dayOfMonth) : ad;
      const { y: fy, m: fm } = parseKey(from);
      const monthsDiff = (fy - ay) * 12 + (fm - am);
      // Start a step early so a same-month candidate later in the month is seen.
      let k = Math.max(0, Math.floor(monthsDiff / interval) - 1);
      for (let i = 0; i < 4; i++, k++) {
        const cand = addMonthsClamped(makeKey(ay, am, 1), k * interval, dom);
        if (compareKeys(cand, from) > 0) return cand;
      }
      return null; // unreachable
    }
    case 'yearly': {
      const { y: ay } = parseKey(anchor);
      const { y: fy } = parseKey(from);
      let k = Math.max(0, Math.floor((fy - ay) / interval) - 1);
      for (let i = 0; i < 4; i++, k++) {
        const cand = addYearsClamped(anchor, k * interval);
        if (compareKeys(cand, from) > 0) return cand;
      }
      return null; // unreachable
    }
  }
}

/** Next occurrence for a repeat-after-completion rule, counted from the
 *  completion day. */
export function nextAfterCompletion(spec: RecurrenceSpec, completedOn: DayKey): DayKey {
  const interval = Math.max(1, Math.floor(spec.interval || 1));
  const delay = spec.repeatDelayValue != null && spec.repeatDelayValue >= 0 && spec.repeatDelayUnit
    ? { value: Math.floor(spec.repeatDelayValue), unit: String(spec.repeatDelayUnit).toLowerCase() }
    : null;
  if (delay) {
    switch (delay.unit) {
      case 'day': case 'days': return addDays(completedOn, delay.value);
      case 'week': case 'weeks': return addDays(completedOn, 7 * delay.value);
      case 'month': case 'months': return addMonthsClamped(completedOn, delay.value);
      case 'year': case 'years': return addYearsClamped(completedOn, delay.value);
      // Unknown unit → fall through to the frequency-based delay.
    }
  }
  switch (effectiveFrequency(spec)) {
    case 'daily': return addDays(completedOn, interval);
    case 'weekly': return addDays(completedOn, 7 * interval);
    case 'monthly': return addMonthsClamped(completedOn, interval);
    case 'yearly': return addYearsClamped(completedOn, interval);
  }
}

/**
 * The next occurrence strictly after `after` ('YYYY-MM-DD'), or null when the
 * rule is exhausted (after_count reached, or past endDate).
 *
 * For repeatAfterCompletion rules `after` must be the completion day of the
 * latest instance (or of the source task); the schedule is not consulted.
 */
export function nextOccurrence(spec: RecurrenceSpec, after: DayKey): DayKey | null {
  parseKey(after); // validate
  const candidate = spec.repeatAfterCompletion ? nextAfterCompletion(spec, after) : nextScheduled(spec, after);
  return applyEnd(spec, candidate);
}

/**
 * Initial/recomputed `nextOccurrence` for a rule as the service stores it on
 * create/update: the first occurrence after both the anchor and today (in the
 * rule's timezone). Occurrences that would have fallen before the rule existed
 * are not back-filled.
 *
 * For repeatAfterCompletion rules the result depends on the source task's
 * completion: pass `completedOn` (day key) when the task is already done,
 * otherwise null is returned and the processor schedules on completion.
 */
export function computeNextFromRule(
  spec: RecurrenceSpec,
  now: Date,
  tz: string,
  completedOn?: DayKey | null,
): DayKey | null {
  if (spec.repeatAfterCompletion) {
    return completedOn ? nextOccurrence(spec, completedOn) : null;
  }
  const today = todayKeyIn(tz, now);
  const after = compareKeys(spec.anchor, today) > 0 ? spec.anchor : today;
  return nextOccurrence(spec, after);
}

// ------------------------------------------------------- zoned wall clock

/** 'YYYY-MM-DD' of `now` in `tz` (same as dates.todayKey; local copy keeps this
 *  module dependency-free for unit tests). */
export function todayKeyIn(tz: string, now: Date): DayKey {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Offset (ms) of `tz` from UTC at instant `at`: local = utc + offset. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => +(parts.find(p => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of wall-clock `HH:MM` on calendar day `key` in `tz`.
 * Handles DST: a time inside the spring-forward gap resolves to the instant
 * after the gap; an ambiguous fall-back time resolves to the first (DST)
 * occurrence.
 */
export function localDateTimeToUtc(key: DayKey, hhmm: string, tz: string): Date {
  const { y, m, d } = parseKey(key);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!tm) throw new Error(`Invalid time: ${hhmm}`);
  const hh = +tm[1], mi = +tm[2];
  if (hh > 23 || mi > 59) throw new Error(`Invalid time: ${hhmm}`);
  const wall = Date.UTC(y, m - 1, d, hh, mi);
  // First guess with the offset in force at the wall time read as UTC, then
  // correct with the offset in force at the guessed instant.
  const off1 = tzOffsetMs(tz, new Date(wall));
  let guess = wall - off1;
  const off2 = tzOffsetMs(tz, new Date(guess));
  if (off2 !== off1) {
    const second = wall - off2;
    // Gap (nonexistent time): neither guess maps back to `wall`; take the later
    // instant. Overlap: both map back; take the earlier (first occurrence).
    const back1 = guess + tzOffsetMs(tz, new Date(guess));
    const back2 = second + tzOffsetMs(tz, new Date(second));
    if (back1 === wall && back2 === wall) guess = Math.min(guess, second);
    else if (back2 === wall) guess = second;
    else if (back1 !== wall) guess = Math.max(guess, second);
  }
  return new Date(guess);
}

/** Subtract a reminder offset from an instant. Units: minutes/hours/days. */
export function subtractOffset(at: Date, value: number, unit: string): Date {
  const v = Math.max(0, Math.floor(value || 0));
  const ms = unit === 'minutes' ? 60_000 : unit === 'hours' ? 3_600_000 : unit === 'days' ? DAY_MS : 0;
  return new Date(at.getTime() - v * ms);
}
