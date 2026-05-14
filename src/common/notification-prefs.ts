// Per-member notification preferences. Stored as JSON on WorkspaceMember.notificationPreferences.
// All fields optional; missing values fall back to PREFS_DEFAULTS (everything enabled).

export type NotificationChannel =
  | 'chat'             // any new chat message
  | 'mention'          // @mentioned in a comment or message
  | 'task_assigned'    // I was assigned a task
  | 'task_status'      // status changed on a task I created/am-assigned-to
  | 'task_comment'     // new comment on a task I care about (creator/assignee)
  | 'reminder'         // a reminder I set fired
  | 'overdue'          // a task I own went overdue
  | 'call'             // incoming voice/video call
  | 'invite'           // workspace/list invite
  ;

export interface QuietHours {
  enabled: boolean;
  startHour: number;   // 0-23 in member's timezone
  endHour: number;     // 0-23 ; wraps if end < start (e.g. 22..7 means 10pm-7am)
}

export interface NotificationPrefs {
  pushEnabled: boolean;                     // master switch for browser push
  inAppEnabled: boolean;                    // master switch for in-app feed/toast
  channels: Record<NotificationChannel, boolean>;
  quietHours: QuietHours;
}

export const PREFS_DEFAULTS: NotificationPrefs = {
  pushEnabled: true,
  inAppEnabled: true,
  channels: {
    chat: true,
    mention: true,
    task_assigned: true,
    task_status: true,
    task_comment: true,
    reminder: true,
    overdue: true,
    call: true,
    invite: true,
  },
  quietHours: { enabled: false, startHour: 22, endHour: 7 },
};

export function mergePrefs(stored: any): NotificationPrefs {
  const s = (stored ?? {}) as Partial<NotificationPrefs>;
  return {
    pushEnabled: s.pushEnabled ?? PREFS_DEFAULTS.pushEnabled,
    inAppEnabled: s.inAppEnabled ?? PREFS_DEFAULTS.inAppEnabled,
    channels: { ...PREFS_DEFAULTS.channels, ...(s.channels || {}) },
    quietHours: { ...PREFS_DEFAULTS.quietHours, ...(s.quietHours || {}) },
  };
}

/** Returns true if `now` falls inside the user's quiet-hours window, in their tz. */
export function isQuietNow(prefs: NotificationPrefs, timezone: string, now = new Date()): boolean {
  if (!prefs.quietHours.enabled) return false;
  // Format the hour in the member's tz; fall back to UTC if tz invalid.
  let hour: number;
  try {
    const f = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone });
    hour = parseInt(f.format(now), 10);
  } catch {
    hour = now.getUTCHours();
  }
  const { startHour, endHour } = prefs.quietHours;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // wrap (e.g. 22..7): match late-evening OR early-morning.
  return hour >= startHour || hour < endHour;
}
