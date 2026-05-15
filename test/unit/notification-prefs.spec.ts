import { mergePrefs, isQuietNow, PREFS_DEFAULTS, NotificationPrefs } from '../../src/common/notification-prefs';

describe('mergePrefs', () => {
  it('returns full defaults when stored is null', () => {
    expect(mergePrefs(null)).toEqual(PREFS_DEFAULTS);
  });

  it('returns full defaults when stored is undefined', () => {
    expect(mergePrefs(undefined)).toEqual(PREFS_DEFAULTS);
  });

  it('overrides only the keys provided', () => {
    const merged = mergePrefs({ pushEnabled: false });
    expect(merged.pushEnabled).toBe(false);
    expect(merged.inAppEnabled).toBe(true);
    expect(merged.channels.chat).toBe(true);
  });

  it('merges channels partial — unspecified channels stay default-true', () => {
    const merged = mergePrefs({ channels: { chat: false } as any });
    expect(merged.channels.chat).toBe(false);
    expect(merged.channels.mention).toBe(true);
    expect(merged.channels.call).toBe(true);
  });

  it('merges quietHours partial — unspecified keys stay default', () => {
    const merged = mergePrefs({ quietHours: { enabled: true } as any });
    expect(merged.quietHours.enabled).toBe(true);
    expect(merged.quietHours.startHour).toBe(22);
    expect(merged.quietHours.endHour).toBe(7);
  });

  it('ignores stored keys that aren\'t recognized (defensive)', () => {
    const merged = mergePrefs({ unknownField: 'x', pushEnabled: false } as any);
    expect((merged as any).unknownField).toBeUndefined();
    expect(merged.pushEnabled).toBe(false);
  });
});

describe('isQuietNow', () => {
  const withQuietHours = (start: number, end: number): NotificationPrefs => ({
    ...PREFS_DEFAULTS,
    quietHours: { enabled: true, startHour: start, endHour: end },
  });

  it('returns false when quietHours.enabled is false', () => {
    const prefs: NotificationPrefs = { ...PREFS_DEFAULTS, quietHours: { enabled: false, startHour: 0, endHour: 23 } };
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T05:00:00Z'))).toBe(false);
  });

  it('non-wrapping window: hour inside window is quiet', () => {
    const prefs = withQuietHours(9, 17);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T12:00:00Z'))).toBe(true);
  });

  it('non-wrapping window: hour outside window is not quiet', () => {
    const prefs = withQuietHours(9, 17);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T20:00:00Z'))).toBe(false);
  });

  it('non-wrapping window: boundary — endHour is exclusive', () => {
    const prefs = withQuietHours(9, 17);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T17:00:00Z'))).toBe(false);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T09:00:00Z'))).toBe(true);
  });

  it('wrapping window (22..7): 23:00 UTC is quiet', () => {
    const prefs = withQuietHours(22, 7);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T23:00:00Z'))).toBe(true);
  });

  it('wrapping window (22..7): 03:00 UTC is quiet', () => {
    const prefs = withQuietHours(22, 7);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T03:00:00Z'))).toBe(true);
  });

  it('wrapping window (22..7): 12:00 UTC is not quiet', () => {
    const prefs = withQuietHours(22, 7);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T12:00:00Z'))).toBe(false);
  });

  it('startHour === endHour → never quiet (degenerate window)', () => {
    const prefs = withQuietHours(9, 9);
    expect(isQuietNow(prefs, 'UTC', new Date('2026-01-01T09:00:00Z'))).toBe(false);
  });

  it('respects timezone — 02:00 UTC in America/New_York is 22:00 prev day, inside 22..7', () => {
    const prefs = withQuietHours(22, 7);
    expect(isQuietNow(prefs, 'America/New_York', new Date('2026-01-02T03:00:00Z'))).toBe(true);
  });

  it('falls back to UTC when timezone is invalid', () => {
    const prefs = withQuietHours(9, 17);
    expect(isQuietNow(prefs, 'NotARealZone', new Date('2026-01-01T12:00:00Z'))).toBe(true);
  });
});
