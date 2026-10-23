import {
  nextOccurrence, computeNextFromRule, nextScheduled, nextAfterCompletion, effectiveFrequency,
  addDays, addMonthsClamped, addYearsClamped, weekday, daysInMonth, isLeapYear,
  keyToDayNumber, dayNumberToKey, toDayKey, localDateTimeToUtc, subtractOffset, RecurrenceSpec,
} from '../../src/common/utils/recurrence';

const NY = 'America/New_York';
// 2026: DST starts Mar 8, ends Nov 1. 2027: Mar 14 / Nov 7.

function spec(over: Partial<RecurrenceSpec> & { anchor: string }): RecurrenceSpec {
  return { frequency: 'daily', interval: 1, daysOfWeek: [], dayOfMonth: null, endType: 'never', ...over };
}

describe('calendar helpers', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
  it('weekday is 0=Sun..6=Sat', () => {
    expect(weekday('2026-06-01')).toBe(1); // Monday
    expect(weekday('2026-06-07')).toBe(0); // Sunday
    expect(weekday('2026-06-06')).toBe(6); // Saturday
    expect(weekday('1970-01-01')).toBe(4); // Thursday
    expect(weekday('1969-12-31')).toBe(3); // negative day numbers
  });
  it('leap years follow the 4/100/400 rule', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2027)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });
  it('addMonthsClamped clamps to the last day and never drifts', () => {
    expect(addMonthsClamped('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2027-01-31', 2)).toBe('2027-03-31');
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsClamped('2026-06-01', 1, 31)).toBe('2026-07-31');
    expect(addMonthsClamped('2026-06-01', 0, 15)).toBe('2026-06-15');
  });
  it('addYearsClamped clamps Feb 29', () => {
    expect(addYearsClamped('2028-02-29', 1)).toBe('2029-02-28');
    expect(addYearsClamped('2028-02-29', 4)).toBe('2032-02-29');
    expect(addYearsClamped('2026-06-01', 2)).toBe('2028-06-01');
  });
  it('day numbers round-trip', () => {
    for (const k of ['1970-01-01', '2026-10-23', '2000-02-29', '2099-12-31']) expect(dayNumberToKey(keyToDayNumber(k))).toBe(k);
    expect(keyToDayNumber('1970-01-02')).toBe(1);
  });
  it('toDayKey accepts keys, Prisma @db.Date values and ISO strings', () => {
    expect(toDayKey('2026-06-03')).toBe('2026-06-03');
    expect(toDayKey(new Date('2026-06-03T00:00:00.000Z'))).toBe('2026-06-03');
    expect(toDayKey('2026-06-03T00:00:00.000Z')).toBe('2026-06-03');
    expect(toDayKey(null)).toBeNull();
    expect(toDayKey(new Date('nope'))).toBeNull();
  });
  it('rejects malformed keys', () => {
    expect(() => nextOccurrence(spec({ anchor: '2026-06-01' }), '06/01/2026')).toThrow();
    expect(() => keyToDayNumber('2026-6-1')).toThrow();
  });
});

describe('effectiveFrequency', () => {
  it('passes concrete frequencies through and folds custom onto the fields present', () => {
    expect(effectiveFrequency(spec({ anchor: '2026-06-01', frequency: 'yearly' }))).toBe('yearly');
    expect(effectiveFrequency(spec({ anchor: '2026-06-01', frequency: 'custom', daysOfWeek: [1, 3] }))).toBe('weekly');
    expect(effectiveFrequency(spec({ anchor: '2026-06-01', frequency: 'custom', dayOfMonth: 15 }))).toBe('monthly');
    expect(effectiveFrequency(spec({ anchor: '2026-06-01', frequency: 'custom' }))).toBe('daily');
  });
});

describe('nextOccurrence — daily', () => {
  const cases: Array<[string, Partial<RecurrenceSpec>, string, string | null]> = [
    ['every day', { interval: 1 }, '2026-06-01', '2026-06-02'],
    ['every 3 days, aligned', { interval: 3 }, '2026-06-01', '2026-06-04'],
    ['every 3 days, next step', { interval: 3 }, '2026-06-04', '2026-06-07'],
    ['every 3 days, misaligned after snaps to the schedule', { interval: 3 }, '2026-06-05', '2026-06-07'],
    ['after before the anchor returns the first occurrence after the anchor', { interval: 1 }, '2026-05-01', '2026-06-02'],
    ['interval 0/invalid is treated as 1', { interval: 0 }, '2026-06-01', '2026-06-02'],
  ];
  it.each(cases)('%s', (_n, over, after, expected) => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'daily', ...over }), after)).toBe(expected);
  });
});

describe('nextOccurrence — weekly', () => {
  // 2026-06-01 is a Monday; its Sunday-start week is May 31 – Jun 6.
  const cases: Array<[string, Partial<RecurrenceSpec>, string, string | null]> = [
    ['no daysOfWeek: anchor weekday, next week', { interval: 1 }, '2026-06-01', '2026-06-08'],
    ['Mon/Wed: Mon → Wed same week', { daysOfWeek: [1, 3] }, '2026-06-01', '2026-06-03'],
    ['Mon/Wed: Wed → next Mon', { daysOfWeek: [1, 3] }, '2026-06-03', '2026-06-08'],
    ['Mon/Wed: Mon → Wed', { daysOfWeek: [1, 3] }, '2026-06-08', '2026-06-10'],
    ['Mon/Wed from a Tuesday after', { daysOfWeek: [1, 3] }, '2026-06-02', '2026-06-03'],
    ['every 2 weeks Mon/Wed: skips the off week', { interval: 2, daysOfWeek: [1, 3] }, '2026-06-03', '2026-06-15'],
    ['every 2 weeks Mon/Wed: Mon → Wed in the on week', { interval: 2, daysOfWeek: [1, 3] }, '2026-06-15', '2026-06-17'],
    ['every 2 weeks Mon/Wed: Wed → Mon two weeks on', { interval: 2, daysOfWeek: [1, 3] }, '2026-06-17', '2026-06-29'],
    ['Sunday rule with a Monday anchor: the Sunday of the next week', { daysOfWeek: [0] }, '2026-06-01', '2026-06-07'],
    ['Sunday every 2 weeks: next Sunday is an off week', { interval: 2, daysOfWeek: [0] }, '2026-06-01', '2026-06-14'],
    ['out-of-range weekdays are ignored', { daysOfWeek: [7, 3, -1] }, '2026-06-01', '2026-06-03'],
    ['unsorted/duplicate weekdays are normalised', { daysOfWeek: [3, 1, 3] }, '2026-06-01', '2026-06-03'],
    ['every 4 weeks, no daysOfWeek', { interval: 4 }, '2026-06-01', '2026-06-29'],
    ['every 4 weeks from a misaligned after snaps to the schedule', { interval: 4 }, '2026-06-10', '2026-06-29'],
  ];
  it.each(cases)('%s', (_n, over, after, expected) => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'weekly', ...over }), after)).toBe(expected);
  });

  it('anchor not on a selected weekday: first selected weekday after it', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-02', frequency: 'weekly', daysOfWeek: [1, 3] }), '2026-06-02')).toBe('2026-06-03');
    expect(nextOccurrence(spec({ anchor: '2026-06-04', frequency: 'weekly', daysOfWeek: [1, 3] }), '2026-06-04')).toBe('2026-06-08');
  });

  it('a long weekly series lands on selected weekdays only', () => {
    const s = spec({ anchor: '2026-06-01', frequency: 'weekly', interval: 3, daysOfWeek: [2, 5] });
    let cur: string | null = '2026-06-01';
    const seen: string[] = [];
    for (let i = 0; i < 12 && cur; i++) { cur = nextOccurrence(s, cur); if (cur) seen.push(cur); }
    expect(seen).toHaveLength(12);
    for (const k of seen) expect([2, 5]).toContain(weekday(k));
    // consecutive pairs sit in the same week; pairs are 3 weeks apart
    expect(seen.slice(0, 4)).toEqual(['2026-06-02', '2026-06-05', '2026-06-23', '2026-06-26']);
  });
});

describe('nextOccurrence — monthly', () => {
  const cases: Array<[string, string, Partial<RecurrenceSpec>, string, string | null]> = [
    ['Jan 31 → Feb 28 (2027, not leap)', '2027-01-31', {}, '2027-01-31', '2027-02-28'],
    ['Feb 28 → Mar 31 (no drift back to the 28th)', '2027-01-31', {}, '2027-02-28', '2027-03-31'],
    ['Mar 31 → Apr 30', '2027-01-31', {}, '2027-03-31', '2027-04-30'],
    ['Jan 31 → Feb 29 (2028 leap)', '2028-01-31', {}, '2028-01-31', '2028-02-29'],
    ['dayOfMonth later in the anchor month is the first occurrence', '2026-06-01', { dayOfMonth: 15 }, '2026-06-01', '2026-06-15'],
    ['dayOfMonth steps monthly', '2026-06-01', { dayOfMonth: 15 }, '2026-06-15', '2026-07-15'],
    ['dayOfMonth 31 every 2 months: Jan → Mar', '2026-01-31', { dayOfMonth: 31, interval: 2 }, '2026-01-31', '2026-03-31'],
    ['dayOfMonth 31 every 2 months: Mar → May', '2026-01-31', { dayOfMonth: 31, interval: 2 }, '2026-03-31', '2026-05-31'],
    ['dayOfMonth 31 every 2 months: Jul → Sep 30', '2026-01-31', { dayOfMonth: 31, interval: 2 }, '2026-07-31', '2026-09-30'],
    ['dayOfMonth 30 in February clamps', '2026-01-30', { dayOfMonth: 30 }, '2026-01-30', '2026-02-28'],
    ['misaligned after snaps to the interval schedule', '2026-01-15', { interval: 3 }, '2026-02-20', '2026-04-15'],
    ['after far before the anchor', '2026-06-15', {}, '2020-01-01', '2026-07-15'],
    ['crosses a year boundary', '2026-11-30', {}, '2026-12-30', '2027-01-30'],
    ['out-of-range dayOfMonth falls back to the anchor day', '2026-06-10', { dayOfMonth: 40 }, '2026-06-10', '2026-07-10'],
  ];
  it.each(cases)('%s', (_n, anchor, over, after, expected) => {
    expect(nextOccurrence(spec({ anchor, frequency: 'monthly', ...over }), after)).toBe(expected);
  });

  it('never drifts: twelve steps from Jan 31 2027 stay on month ends', () => {
    const s = spec({ anchor: '2027-01-31', frequency: 'monthly' });
    let cur: string | null = '2027-01-31';
    const seen: string[] = [];
    for (let i = 0; i < 13; i++) { cur = nextOccurrence(s, cur!); seen.push(cur!); }
    expect(seen).toEqual([
      '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30', '2027-07-31',
      '2027-08-31', '2027-09-30', '2027-10-31', '2027-11-30', '2027-12-31', '2028-01-31', '2028-02-29',
    ]);
    expect(seen).not.toContain('2027-03-03'); // the old setMonth drift
  });
});

describe('nextOccurrence — yearly', () => {
  const cases: Array<[string, string, Partial<RecurrenceSpec>, string, string | null]> = [
    ['Feb 29 → Feb 28 next year', '2028-02-29', {}, '2028-02-29', '2029-02-28'],
    ['Feb 28 (clamped) → Feb 28', '2028-02-29', {}, '2029-02-28', '2030-02-28'],
    ['back to Feb 29 in the next leap year', '2028-02-29', {}, '2031-02-28', '2032-02-29'],
    ['every 2 years', '2026-06-01', { interval: 2 }, '2026-06-01', '2028-06-01'],
    ['every 2 years from a misaligned after', '2026-06-01', { interval: 2 }, '2027-01-01', '2028-06-01'],
    ['after before the anchor', '2026-06-01', {}, '2000-01-01', '2027-06-01'],
    ['same-year after earlier than the anchor day', '2026-06-01', {}, '2027-03-01', '2027-06-01'],
  ];
  it.each(cases)('%s', (_n, anchor, over, after, expected) => {
    expect(nextOccurrence(spec({ anchor, frequency: 'yearly', ...over }), after)).toBe(expected);
  });
});

describe('nextOccurrence — end conditions', () => {
  it('after_count counts the source task as #1 and stops when the total is reached', () => {
    const base = spec({ anchor: '2026-06-01', endType: 'after_count', endCount: 3 });
    expect(nextOccurrence({ ...base, generatedCount: 0 }, '2026-06-01')).toBe('2026-06-02');
    expect(nextOccurrence({ ...base, generatedCount: 1 }, '2026-06-02')).toBe('2026-06-03');
    expect(nextOccurrence({ ...base, generatedCount: 2 }, '2026-06-03')).toBeNull();
    expect(nextOccurrence({ ...base, generatedCount: 5 }, '2026-06-03')).toBeNull();
  });
  it('after_count of 1 means the source task only', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', endType: 'after_count', endCount: 1 }), '2026-06-01')).toBeNull();
  });
  it('after_count without a count is unbounded', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', endType: 'after_count', endCount: null, generatedCount: 999 }), '2026-06-01')).toBe('2026-06-02');
  });
  it('on_date is inclusive of endDate', () => {
    const s = spec({ anchor: '2026-06-01', endType: 'on_date', endDate: '2026-06-03' });
    expect(nextOccurrence(s, '2026-06-02')).toBe('2026-06-03');
    expect(nextOccurrence(s, '2026-06-03')).toBeNull();
  });
  it('on_date accepts the Prisma @db.Date representation', () => {
    const s = spec({ anchor: '2026-06-01', endType: 'on_date', endDate: new Date('2026-06-03T00:00:00.000Z') });
    expect(nextOccurrence(s, '2026-06-02')).toBe('2026-06-03');
    expect(nextOccurrence(s, '2026-06-03')).toBeNull();
  });
  it('on_date before the first occurrence exhausts immediately', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'weekly', endType: 'on_date', endDate: '2026-06-05' }), '2026-06-01')).toBeNull();
  });
  it('never ignores endCount/endDate', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', endType: 'never', endCount: 1, endDate: '2020-01-01' }), '2026-06-01')).toBe('2026-06-02');
  });
  it('end conditions apply to weekly/monthly/yearly candidates too', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'weekly', daysOfWeek: [1, 3], endType: 'on_date', endDate: '2026-06-03' }), '2026-06-03')).toBeNull();
    expect(nextOccurrence(spec({ anchor: '2027-01-31', frequency: 'monthly', endType: 'on_date', endDate: '2027-02-28' }), '2027-01-31')).toBe('2027-02-28');
    expect(nextOccurrence(spec({ anchor: '2028-02-29', frequency: 'yearly', endType: 'after_count', endCount: 2, generatedCount: 1 }), '2029-02-28')).toBeNull();
  });
});

describe('nextOccurrence — repeatAfterCompletion', () => {
  it('counts one interval of the frequency from the completion day when no delay is set', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'daily', interval: 3, repeatAfterCompletion: true }), '2026-06-10')).toBe('2026-06-13');
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'weekly', daysOfWeek: [1, 3], repeatAfterCompletion: true }), '2026-06-10')).toBe('2026-06-17'); // daysOfWeek ignored
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'monthly', repeatAfterCompletion: true }), '2027-01-31')).toBe('2027-02-28');
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'yearly', repeatAfterCompletion: true }), '2028-02-29')).toBe('2029-02-28');
  });
  it('uses repeatDelayValue/Unit when present', () => {
    const base = spec({ anchor: '2026-06-01', frequency: 'weekly', repeatAfterCompletion: true });
    expect(nextOccurrence({ ...base, repeatDelayValue: 2, repeatDelayUnit: 'days' }, '2026-06-10')).toBe('2026-06-12');
    expect(nextOccurrence({ ...base, repeatDelayValue: 1, repeatDelayUnit: 'weeks' }, '2026-06-10')).toBe('2026-06-17');
    expect(nextOccurrence({ ...base, repeatDelayValue: 1, repeatDelayUnit: 'months' }, '2027-01-31')).toBe('2027-02-28');
    expect(nextOccurrence({ ...base, repeatDelayValue: 1, repeatDelayUnit: 'years' }, '2028-02-29')).toBe('2029-02-28');
    expect(nextOccurrence({ ...base, repeatDelayValue: 0, repeatDelayUnit: 'days' }, '2026-06-10')).toBe('2026-06-10');
  });
  it('falls back to the frequency for an unknown delay unit', () => {
    expect(nextAfterCompletion(spec({ anchor: '2026-06-01', frequency: 'daily', repeatAfterCompletion: true, repeatDelayValue: 5, repeatDelayUnit: 'fortnights' }), '2026-06-10')).toBe('2026-06-11');
  });
  it('still honours end conditions', () => {
    expect(nextOccurrence(spec({ anchor: '2026-06-01', repeatAfterCompletion: true, endType: 'after_count', endCount: 2, generatedCount: 1 }), '2026-06-10')).toBeNull();
    expect(nextOccurrence(spec({ anchor: '2026-06-01', repeatAfterCompletion: true, endType: 'on_date', endDate: '2026-06-10' }), '2026-06-10')).toBeNull();
    expect(nextOccurrence(spec({ anchor: '2026-06-01', repeatAfterCompletion: true, endType: 'on_date', endDate: '2026-06-11' }), '2026-06-10')).toBe('2026-06-11');
  });
  it('does not consult the schedule anchor', () => {
    expect(nextScheduled(spec({ anchor: '2026-06-01', frequency: 'weekly' }), '2026-06-10')).toBe('2026-06-15');
    expect(nextOccurrence(spec({ anchor: '2026-06-01', frequency: 'weekly', repeatAfterCompletion: true }), '2026-06-10')).toBe('2026-06-17');
  });
});

describe('nextOccurrence — DST transitions in America/New_York stay on calendar days', () => {
  it('daily across spring-forward (2026-03-08)', () => {
    const s = spec({ anchor: '2026-03-01' });
    expect(nextOccurrence(s, '2026-03-07')).toBe('2026-03-08');
    expect(nextOccurrence(s, '2026-03-08')).toBe('2026-03-09');
  });
  it('daily across fall-back (2026-11-01)', () => {
    const s = spec({ anchor: '2026-10-01' });
    expect(nextOccurrence(s, '2026-10-31')).toBe('2026-11-01');
    expect(nextOccurrence(s, '2026-11-01')).toBe('2026-11-02');
  });
  it('weekly Sundays land on the transition Sundays themselves', () => {
    expect(nextOccurrence(spec({ anchor: '2026-03-01', frequency: 'weekly', daysOfWeek: [0] }), '2026-03-01')).toBe('2026-03-08');
    expect(nextOccurrence(spec({ anchor: '2026-03-01', frequency: 'weekly', daysOfWeek: [0] }), '2026-03-08')).toBe('2026-03-15');
    expect(nextOccurrence(spec({ anchor: '2026-10-25', frequency: 'weekly', daysOfWeek: [0] }), '2026-10-25')).toBe('2026-11-01');
    expect(nextOccurrence(spec({ anchor: '2027-03-07', frequency: 'weekly', daysOfWeek: [0] }), '2027-03-07')).toBe('2027-03-14');
    expect(nextOccurrence(spec({ anchor: '2027-10-31', frequency: 'weekly', daysOfWeek: [0] }), '2027-10-31')).toBe('2027-11-07');
  });
  it('monthly onto the transition days', () => {
    expect(nextOccurrence(spec({ anchor: '2026-02-08', frequency: 'monthly' }), '2026-02-08')).toBe('2026-03-08');
    expect(nextOccurrence(spec({ anchor: '2026-10-01', frequency: 'monthly' }), '2026-10-01')).toBe('2026-11-01');
  });
  it('a year of daily steps is exactly 365 distinct consecutive days', () => {
    const s = spec({ anchor: '2026-01-01' });
    let cur = '2026-01-01';
    for (let i = 0; i < 365; i++) {
      const n = nextOccurrence(s, cur)!;
      expect(keyToDayNumber(n) - keyToDayNumber(cur)).toBe(1);
      cur = n;
    }
    expect(cur).toBe('2027-01-01');
  });
});

describe('computeNextFromRule', () => {
  const now = new Date('2026-10-23T12:00:00.000Z'); // Friday, noon UTC = 08:00 EDT

  it('future anchor: first occurrence after the anchor (source task covers the anchor day)', () => {
    expect(computeNextFromRule(spec({ anchor: '2030-06-01', frequency: 'weekly' }), now, NY)).toBe('2030-06-08');
    expect(computeNextFromRule(spec({ anchor: '2030-06-01', frequency: 'daily' }), now, NY)).toBe('2030-06-02');
  });
  it('past anchor: first occurrence after today, no back-fill', () => {
    // Anchor Monday 2026-05-04, weekly → next Monday after Fri Oct 23 is Oct 26.
    expect(computeNextFromRule(spec({ anchor: '2026-05-04', frequency: 'weekly' }), now, NY)).toBe('2026-10-26');
    expect(computeNextFromRule(spec({ anchor: '2026-01-01', frequency: 'daily' }), now, NY)).toBe('2026-10-24');
  });
  it('anchor today: next occurrence after today', () => {
    expect(computeNextFromRule(spec({ anchor: '2026-10-23', frequency: 'daily' }), now, NY)).toBe('2026-10-24');
  });
  it('today is judged in the given timezone', () => {
    const lateEveningET = new Date('2026-10-24T03:30:00.000Z'); // Oct 23, 23:30 in New York
    const s = spec({ anchor: '2026-10-01', frequency: 'daily' });
    expect(computeNextFromRule(s, lateEveningET, NY)).toBe('2026-10-24');
    expect(computeNextFromRule(s, lateEveningET, 'UTC')).toBe('2026-10-25');
  });
  it('honours end conditions', () => {
    expect(computeNextFromRule(spec({ anchor: '2026-01-01', frequency: 'daily', endType: 'on_date', endDate: '2026-06-01' }), now, NY)).toBeNull();
    expect(computeNextFromRule(spec({ anchor: '2030-06-01', frequency: 'daily', endType: 'after_count', endCount: 1 }), now, NY)).toBeNull();
  });
  it('repeatAfterCompletion: null until completed, then from the completion day', () => {
    const s = spec({ anchor: '2026-10-01', frequency: 'weekly', repeatAfterCompletion: true });
    expect(computeNextFromRule(s, now, NY)).toBeNull();
    expect(computeNextFromRule(s, now, NY, null)).toBeNull();
    expect(computeNextFromRule(s, now, NY, '2026-10-20')).toBe('2026-10-27');
  });
});

describe('localDateTimeToUtc', () => {
  it('converts wall-clock time in a zone to the UTC instant', () => {
    expect(localDateTimeToUtc('2026-06-01', '09:00', NY).toISOString()).toBe('2026-06-01T13:00:00.000Z'); // EDT
    expect(localDateTimeToUtc('2026-01-15', '09:00', NY).toISOString()).toBe('2026-01-15T14:00:00.000Z'); // EST
    expect(localDateTimeToUtc('2026-06-01', '09:00', 'UTC').toISOString()).toBe('2026-06-01T09:00:00.000Z');
    expect(localDateTimeToUtc('2026-06-01', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-06-01T03:30:00.000Z');
    expect(localDateTimeToUtc('2026-06-01', '17:30', 'Europe/London').toISOString()).toBe('2026-06-01T16:30:00.000Z');
    expect(localDateTimeToUtc('2026-06-01', '00:00', 'Pacific/Auckland').toISOString()).toBe('2026-05-31T12:00:00.000Z');
  });
  it('handles the DST transition days', () => {
    expect(localDateTimeToUtc('2026-03-08', '09:00', NY).toISOString()).toBe('2026-03-08T13:00:00.000Z'); // after spring-forward: EDT
    expect(localDateTimeToUtc('2026-03-08', '01:00', NY).toISOString()).toBe('2026-03-08T06:00:00.000Z'); // before: EST
    expect(localDateTimeToUtc('2026-11-01', '09:00', NY).toISOString()).toBe('2026-11-01T14:00:00.000Z'); // after fall-back: EST
    expect(localDateTimeToUtc('2026-11-01', '00:30', NY).toISOString()).toBe('2026-11-01T04:30:00.000Z'); // before: EDT
    expect(localDateTimeToUtc('2026-03-07', '09:00', NY).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(localDateTimeToUtc('2026-10-31', '09:00', NY).toISOString()).toBe('2026-10-31T13:00:00.000Z');
  });
  it('a time in the spring-forward gap resolves to the instant after the gap', () => {
    // 02:30 does not exist on 2026-03-08 in New York; 03:30 EDT = 07:30Z.
    expect(localDateTimeToUtc('2026-03-08', '02:30', NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('an ambiguous fall-back time resolves to the first (DST) occurrence', () => {
    // 01:30 happens twice on 2026-11-01; the first is EDT = 05:30Z.
    expect(localDateTimeToUtc('2026-11-01', '01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
  it('rejects malformed times', () => {
    expect(() => localDateTimeToUtc('2026-06-01', '9am', NY)).toThrow();
    expect(() => localDateTimeToUtc('2026-06-01', '24:00', NY)).toThrow();
    expect(() => localDateTimeToUtc('2026-06-01', '09:60', NY)).toThrow();
  });
});

describe('subtractOffset', () => {
  const at = new Date('2026-06-01T13:00:00.000Z');
  it('subtracts minutes/hours/days', () => {
    expect(subtractOffset(at, 30, 'minutes').toISOString()).toBe('2026-06-01T12:30:00.000Z');
    expect(subtractOffset(at, 2, 'hours').toISOString()).toBe('2026-06-01T11:00:00.000Z');
    expect(subtractOffset(at, 1, 'days').toISOString()).toBe('2026-05-31T13:00:00.000Z');
  });
  it('unknown unit or negative value leaves the instant unchanged', () => {
    expect(subtractOffset(at, 5, 'weeks').getTime()).toBe(at.getTime());
    expect(subtractOffset(at, -5, 'hours').getTime()).toBe(at.getTime());
  });
});
