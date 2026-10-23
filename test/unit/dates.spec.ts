import { workspaceTimezone, todayKey, dateKeyToDb, dbDateToKey, daysLate, DEFAULT_WORKSPACE_TIMEZONE } from '../../src/common/utils/dates';

describe('date helpers', () => {
  describe('workspaceTimezone', () => {
    it('defaults to America/New_York when unset, non-string, or invalid', () => {
      expect(workspaceTimezone({})).toBe(DEFAULT_WORKSPACE_TIMEZONE);
      expect(workspaceTimezone(null)).toBe(DEFAULT_WORKSPACE_TIMEZONE);
      expect(workspaceTimezone({ timezone: 42 })).toBe(DEFAULT_WORKSPACE_TIMEZONE);
      expect(workspaceTimezone({ timezone: 'Mars/Olympus' })).toBe(DEFAULT_WORKSPACE_TIMEZONE);
    });
    it('returns a valid IANA zone as-is', () => {
      expect(workspaceTimezone({ timezone: 'Europe/London' })).toBe('Europe/London');
    });
  });

  describe('todayKey', () => {
    // 2026-10-23T03:30Z is still the evening of Oct 22 in New York (UTC-4).
    const lateEveningET = new Date('2026-10-23T03:30:00.000Z');
    it('is the local calendar day, not the UTC one', () => {
      expect(todayKey('America/New_York', lateEveningET)).toBe('2026-10-22');
      expect(todayKey('UTC', lateEveningET)).toBe('2026-10-23');
      expect(todayKey('Asia/Kolkata', lateEveningET)).toBe('2026-10-23');
    });
    it('rolls over at local midnight', () => {
      expect(todayKey('America/New_York', new Date('2026-10-23T03:59:59.000Z'))).toBe('2026-10-22');
      expect(todayKey('America/New_York', new Date('2026-10-23T04:00:00.000Z'))).toBe('2026-10-23');
    });
  });

  it('dateKeyToDb / dbDateToKey round-trip the Prisma @db.Date representation', () => {
    const d = dateKeyToDb('2026-10-22');
    expect(d.toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(dbDateToKey(d)).toBe('2026-10-22');
  });

  it('daysLate counts calendar days against the given today', () => {
    const due = dateKeyToDb('2026-10-22');
    expect(daysLate(due, '2026-10-22')).toBe(0);
    expect(daysLate(due, '2026-10-23')).toBe(1);
    expect(daysLate(due, '2026-10-20')).toBe(-2);
  });

  it('a task due today is not overdue at 11 pm Eastern (the bug this replaces)', () => {
    const now = new Date('2026-10-23T03:00:00.000Z'); // 11 pm Oct 22 ET
    const due = dateKeyToDb('2026-10-22');
    const today = todayKey('America/New_York', now);
    expect(due < dateKeyToDb(today)).toBe(false); // not overdue
    expect(dbDateToKey(due) === today).toBe(true); // due today
    // The old comparison said otherwise:
    expect(due < now).toBe(true);
  });
});
