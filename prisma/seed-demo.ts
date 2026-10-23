/**
 * Demo-data seed: "Meridian Property Group", a fictional mid-Atlantic rental
 * company with ~2.5 years of realistic TaskForge history.
 *
 *   npm run seed:demo                 # seeds once; exits if the demo workspace exists
 *   SEED_DEMO_RESET=1 npm run seed:demo   # deletes ONLY the demo workspace + demo users, re-seeds
 *
 * Reads DATABASE_URL (and DIRECT_URL) like the app. Deterministic (mulberry32)
 * apart from the real "now". Never touches rows outside the demo workspace and
 * the @meridian.example users. The shared password + raw invite / reset tokens
 * are written to ./.demo-credentials.txt, never to stdout.
 *
 * Row shapes mirror the services that write each table (tasks, comments,
 * messages, notifications, audit interceptor, recurrence worker, …).
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { nextOccurrence, computeNextFromRule, RecurrenceSpec, localDateTimeToUtc, subtractOffset } from '../src/common/utils/recurrence';
import { dateKeyToDb, dbDateToKey } from '../src/common/utils/dates';
import * as U from './seed-demo/util';
import * as C from './seed-demo/content';

type DayKey = U.DayKey;

const SLUG = 'meridian-property-group-demo';
const WS_NAME = 'Meridian Property Group';
const START_DAY: DayKey = '2024-04-01';
const NOW = new Date();
const TODAY: DayKey = U.todayKeyIn(U.TZ, NOW);
const FULL_FIDELITY_DAYS = 21;   // every notification kept for this window; older ones sampled
const OLD_NOTIF_SAMPLE = 0.04;
const INBOUND_DOMAIN = process.env.INBOUND_EMAIL_DOMAIN || 'inbound.taskforge.io';
const CREDS_PATH = join(process.cwd(), '.demo-credentials.txt');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ───────────────────────────────────────────────────────────── env guard

process.env.DIRECT_URL ||= process.env.DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (/\/taskforge_test(\?|$)/.test(process.env.DATABASE_URL)) {
  console.error('Refusing to seed demo data into the Jest test database (taskforge_test).');
  process.exit(1);
}

const prisma = new PrismaClient();

// ───────────────────────────────────────────────────────────── types

interface Member {
  id: string; userId: string; key: string; p: C.Person; email: string; name: string; first: string;
  role: C.Role; managerId: string | null; tz: string; joinDay: DayKey; leftDay: DayKey | null; active: boolean;
  invitedBy: string | null; prefs: any; ips: string[]; uas: string[];
}
interface ListRec {
  id: string; key: string; name: string; cat: string; createdAt: Date; createdDay: DayKey; createdBy: Member;
  memberKeys: string[]; defaultAssignee: Member | null; archivedAt: Date | null; inboundEmail: string; inboundEnabled: boolean; description: string | null;
}
interface TaskRow {
  id: string; workspaceId: string; listId: string; parentTaskId: string | null; title: string; description: string | null;
  status: string; priority: string; creatorId: string; assigneeId: string | null; source: string; isLocked: boolean;
  lockedById: string | null; lockedAt: Date | null; startDate: Date | null; startTime: string | null; dueDate: Date | null;
  dueTime: string | null; timezone: string | null; completedAt: Date | null; archivedAt: Date | null; deletedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}
interface TaskSpec {
  list: ListRec; title: string; description?: string | null; creator: Member; assignee: Member | null; createdAt: Date;
  due?: DayKey | null; dueTime?: string | null; startDay?: DayKey | null; priority?: string; source?: string;
  status: 'done' | 'todo' | 'in_progress' | 'waiting_for'; completedAt?: Date | null; parentTaskId?: string | null;
  lockedBy?: Member | null; deletedAt?: Date | null; manualArchive?: { by: Member; at: Date } | null; noAutoArchive?: boolean;
  checklist?: { text: string; checked: boolean }[]; timezone?: string | null; skipAudit?: boolean;
}

// ───────────────────────────────────────────────────────────── builder

class Builder {
  rng = new U.Rng(20240401);
  wsId = '';
  members: Member[] = [];
  byKey = new Map<string, Member>();
  lists: ListRec[] = [];
  listByKey = new Map<string, ListRec>();
  listMembers: any[] = [];
  tasks: TaskRow[] = [];
  taskList = new Map<string, ListRec>();
  emailMeta: any[] = [];
  checklist: any[] = [];
  rules: any[] = [];
  instances: any[] = [];
  comments: any[] = [];
  mentions: any[] = [];
  attachments: any[] = [];
  uploads = new Map<string, { body: Buffer; mime: string }>();
  reminders: any[] = [];
  notifications: any[] = [];
  templates: any[] = [];
  views: any[] = [];
  audits: any[] = [];
  invitations: any[] = [];
  conversations: any[] = [];
  convMembers: any[] = [];
  messages: any[] = [];
  reactions: any[] = [];
  refreshTokens: any[] = [];
  resetTokens: any[] = [];
  secrets: { inviteToken?: string; resetToken?: string; resetEmail?: string; resetExpires?: Date } = {};
  taskFootprint = new Map<string, number>(); // task id → number of comments (for spreading)
  pngs: Buffer[] = [];
  wav = U.makeWav();

  constructor(private sahilUserId: string, private sahilName: string, private userIdByKey: Map<string, string>) {
    for (let i = 0; i < 8; i++) this.pngs.push(U.makePng(96 + i * 8, 72 + i * 6, [this.rng.int(40, 220), this.rng.int(40, 220), this.rng.int(40, 220)]));
  }

  // ── helpers ────────────────────────────────────────────────────────────
  M(key: string): Member { const m = this.byKey.get(key); if (!m) throw new Error(`no member ${key}`); return m; }
  L(key: string): ListRec { const l = this.listByKey.get(key); if (!l) throw new Error(`no list ${key}`); return l; }
  activeOn(m: Member, day: DayKey): boolean { return day >= m.joinDay && (!m.leftDay || day < m.leftDay); }
  activeAt(m: Member, at: Date): boolean { return this.activeOn(m, U.dayOf(at)); }
  mention(m: Member): string { return `@${m.email}`; }
  prop() { return this.rng.pick(C.PROPERTIES); }
  slots(): Record<string, string> {
    const p = this.prop(), p2 = this.prop();
    const month = C.MONTHS[this.rng.int(0, 11)];
    return {
      unit: C.unitLabel(p, this.rng.pick(p.units)), unit2: C.unitLabel(p2, this.rng.pick(p2.units)), prop: p.name,
      tenant: this.rng.pick(C.TENANTS), vendor: this.rng.pick(C.VENDORS), issue: this.rng.pick(C.ISSUES),
      amount: this.rng.pick(C.AMOUNTS), month, year: String(this.rng.int(2024, 2027)),
    };
  }
  cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

  audit(actor: Member, action: string, entityType: string, entityId: string, changes: any, at: Date) {
    this.audits.push({
      workspaceId: this.wsId, actorId: actor.id, action, entityType, entityId, changes: changes ?? {},
      ipAddress: this.rng.pick(actor.ips), userAgent: this.rng.pick(actor.uas), createdAt: at,
    });
  }

  /** Mirrors NotificationsService.dispatch: prefs gate, data shape, no self/inactive. */
  notify(recipient: Member, type: string, channel: string, title: string, body: string, url: string, entityType: string, entityId: string, at: Date, force = false) {
    if (at.getTime() > NOW.getTime()) return null;
    if (!this.activeAt(recipient, at)) return null;
    const prefs = recipient.prefs || {};
    const channelOn = !(prefs.channels && prefs.channels[channel] === false);
    const highPriority = type === 'call_invite';
    if (!((prefs.inAppEnabled !== false && channelOn) || highPriority)) return null;
    const ageDays = (NOW.getTime() - at.getTime()) / U.DAY_MS;
    if (!force && ageDays > FULL_FIDELITY_DAYS && !this.rng.chance(OLD_NOTIF_SAMPLE)) return null;
    const row = {
      id: this.rng.uuid(), workspaceId: this.wsId, recipientId: recipient.id, type, title: U.truncate(title, 255), body,
      data: { url, channel, entityType, entityId }, isRead: false, readAt: null as Date | null, createdAt: at,
    };
    this.notifications.push(row);
    return row;
  }

  // ── members ────────────────────────────────────────────────────────────
  buildMembers() {
    const eightMonthsAgo = U.dayNumberToKey(U.keyToDayNumber(TODAY) - 243);
    const sixDaysAgo = U.addDays(TODAY, -6);
    const people = C.PEOPLE.map(p => ({ ...p, joinDay: p.joinDay === 'NEW_HIRE' ? sixDaysAgo : p.joinDay, leftDay: p.leftDay === 'LEFT_8_MONTHS_AGO' ? eightMonthsAgo : p.leftDay }));
    const mk = (p: C.Person & { joinDay: string; leftDay?: string }, userId: string, email: string, key: string): Member => ({
      id: this.rng.uuid(), userId, key, p, email, name: p.name, first: p.name.split(' ')[0], role: p.role, managerId: null,
      tz: p.tz || U.TZ, joinDay: p.joinDay, leftDay: p.leftDay || null, active: !p.leftDay, invitedBy: null, prefs: p.prefs || {},
      ips: [`${this.rng.int(24, 99)}.${this.rng.int(1, 254)}.${this.rng.int(1, 254)}.${this.rng.int(1, 254)}`, `${this.rng.int(100, 199)}.${this.rng.int(1, 254)}.${this.rng.int(1, 254)}.${this.rng.int(1, 254)}`],
      uas: this.rng.sample(C.USER_AGENTS, 2),
    });
    const sahilPerson: C.Person = { key: 'sahil', name: this.sahilName, handle: '', role: 'admin', title: 'Admin', joinDay: START_DAY, weight: 0.8 };
    this.members.push(mk(sahilPerson as any, this.sahilUserId, C.SAHIL_EMAIL, 'sahil'));
    for (const p of people) this.members.push(mk(p as any, this.userIdByKey.get(p.key)!, `${p.handle}@${C.DOMAIN}`, p.key));
    for (const m of this.members) this.byKey.set(m.key, m);
    for (const m of this.members) {
      if (m.p.managerKey) m.managerId = this.M(m.p.managerKey).id;
      if (m.p.invitedByKey) m.invitedBy = this.M(m.p.invitedByKey).id;
    }
  }

  memberRows() {
    return this.members.map(m => ({
      id: m.id, workspaceId: this.wsId, userId: m.userId, role: m.role, managerId: m.managerId, notificationPreferences: m.prefs,
      timezone: m.tz, invitedBy: m.invitedBy, isActive: m.active, createdAt: U.at(m.joinDay, m.key === 'sahil' ? '09:05' : U.hhmm(this.rng.int(8, 16), this.rng.int(0, 59))),
      updatedAt: m.leftDay ? U.at(m.leftDay, '10:12') : U.at(m.joinDay, '17:00'),
    }));
  }

  // ── invitations ────────────────────────────────────────────────────────
  buildInvitations() {
    const dana = this.M('dana');
    for (const m of this.members) {
      if (!m.p.acceptedInvite) continue;
      const inviter = this.byKey.get(m.p.invitedByKey || 'dana') || dana;
      const acceptedAt = U.at(m.joinDay, '09:40');
      const createdAt = U.plusDays(acceptedAt, -this.rng.int(1, 3));
      const inv = {
        id: this.rng.uuid(), workspaceId: this.wsId, email: m.email, name: m.name, role: m.role, managerId: m.managerId,
        tokenHash: sha256(this.rng.hex(32)), expiresAt: U.plusDays(createdAt, 7), acceptedAt, invitedBy: inviter.id, createdAt,
      };
      this.invitations.push(inv);
      this.audit(inviter, 'invitation.created', 'invitation', inv.id, { email: inv.email, role: inv.role }, createdAt);
      this.notify(m, 'invite', 'invite', 'You joined a new workspace', `Welcome to ${WS_NAME}`, '/', 'workspace', this.wsId, U.plusMin(acceptedAt, 1), true);
    }
    // Pending, valid: created 9 days ago, resent 2 days ago → expires in 5 days. Raw token goes to the credentials file.
    const rawInvite = randomBytes(32).toString('hex');
    this.secrets.inviteToken = rawInvite;
    const pCreated = U.plusDays(NOW, -9), pResent = U.plusDays(NOW, -2);
    const pending = {
      id: this.rng.uuid(), workspaceId: this.wsId, email: `casey.morgan@${C.DOMAIN}`, name: 'Casey Morgan', role: 'employee', managerId: this.M('marcus').id,
      tokenHash: sha256(rawInvite), expiresAt: U.plusDays(pResent, 7), acceptedAt: null, invitedBy: this.M('elena').id, createdAt: pCreated,
    };
    this.invitations.push(pending);
    this.audit(this.M('elena'), 'invitation.created', 'invitation', pending.id, { email: pending.email, role: 'employee' }, pCreated);
    this.audit(this.M('elena'), 'invitation.resent', 'invitation', pending.id, { email: pending.email }, pResent);
    // Expired: created 40 days ago, never accepted.
    const eCreated = U.plusDays(NOW, -40);
    const expired = {
      id: this.rng.uuid(), workspaceId: this.wsId, email: `seasonal.leasing@${C.DOMAIN}`, name: 'Avery Coleman', role: 'employee', managerId: this.M('marcus').id,
      tokenHash: sha256(this.rng.hex(32)), expiresAt: U.plusDays(eCreated, 7), acceptedAt: null, invitedBy: dana.id, createdAt: eCreated,
    };
    this.invitations.push(expired);
    this.audit(dana, 'invitation.created', 'invitation', expired.id, { email: expired.email, role: 'employee' }, eCreated);
    // Revoked: the API deletes the row, so only the audit trail remains.
    const rId = this.rng.uuid(), rCreated = U.plusDays(NOW, -30);
    this.audit(dana, 'invitation.created', 'invitation', rId, { email: `contractor.temp@${C.DOMAIN}`, role: 'employee' }, rCreated);
    this.audit(dana, 'invitation.revoked', 'invitation', rId, undefined, U.plusDays(rCreated, 2));
    // Two admin-initiated password rotations.
    this.audit(dana, 'member.password-rotated', 'workspaceMember', this.M('hannah').id, { email: this.M('hannah').email }, U.at(U.addDays(TODAY, -75), '11:20'));
    this.audit(this.M('elena'), 'member.password-rotated', 'workspaceMember', this.M('samir').id, { email: this.M('samir').email }, U.at(U.addDays(TODAY, -12), '15:05'));
  }

  // ── lists ──────────────────────────────────────────────────────────────
  addList(cfg: { key: string; name: string; cat: string; createdBy: string; createdDay: DayKey; members: string[]; defaultAssignee?: string | null; inbound?: boolean; archivedAt?: Date | null; description?: string }) {
    const createdBy = this.M(cfg.createdBy);
    const createdAt = U.workInstant(this.rng, cfg.createdDay);
    const l: ListRec = {
      id: this.rng.uuid(), key: cfg.key, name: cfg.name, cat: cfg.cat, createdAt, createdDay: cfg.createdDay, createdBy,
      memberKeys: Array.from(new Set(cfg.members)), defaultAssignee: cfg.defaultAssignee ? this.M(cfg.defaultAssignee) : null,
      archivedAt: cfg.archivedAt || null, inboundEmail: `${this.rng.uuid()}@${INBOUND_DOMAIN}`, inboundEnabled: !!cfg.inbound, description: cfg.description || null,
    };
    this.lists.push(l);
    this.listByKey.set(l.key, l);
    for (const k of l.memberKeys) {
      const m = this.M(k);
      // Members join the list when it is created, or when they themselves join the company.
      const joinDay = m.joinDay > l.createdDay ? m.joinDay : l.createdDay;
      const addedAt = joinDay === l.createdDay ? U.plusMin(createdAt, this.rng.int(0, 30)) : U.workInstant(this.rng, U.addDays(joinDay, this.rng.int(0, 2)));
      this.listMembers.push({ id: this.rng.uuid(), listId: l.id, workspaceMemberId: m.id, addedById: createdBy.id, createdAt: addedAt });
    }
    return l;
  }

  listRows() {
    return this.lists.map(l => ({
      id: l.id, workspaceId: this.wsId, name: l.name, description: l.description, inboundEmail: l.inboundEmail, inboundEmailEnabled: l.inboundEnabled,
      defaultAssigneeId: l.defaultAssignee?.id ?? null, settings: {}, createdById: l.createdBy.id, archivedAt: l.archivedAt, createdAt: l.createdAt,
      updatedAt: l.archivedAt || l.createdAt,
    }));
  }

  buildLists() {
    const d = (k: DayKey) => k;
    this.addList({ key: 'leasing', name: 'Leasing', cat: 'leasing', createdBy: 'dana', createdDay: d('2024-04-10'), members: ['dana', 'marcus', 'jordan', 'kevin', 'renee', 'grace', 'hannah', 'maya'], defaultAssignee: 'jordan', description: 'Showings, applications, renewals and move-ins across all properties.' });
    this.addList({ key: 'oak', name: 'Maintenance — Oakridge Apartments', cat: 'maint', createdBy: 'marcus', createdDay: d('2024-04-12'), members: ['marcus', 'luis', 'tasha', 'kevin', 'diego', 'samir', 'ethan'], defaultAssignee: 'luis', inbound: true, description: 'Work orders for the 16 Oakridge units. Tenants can email this list directly.' });
    this.addList({ key: 'hv', name: 'Maintenance — Harbor View Townhomes', cat: 'maint', createdBy: 'marcus', createdDay: d('2024-04-12'), members: ['marcus', 'luis', 'tasha', 'diego', 'samir'], description: 'Work orders for Harbor View (24 townhomes).' });
    this.addList({ key: 'turn', name: 'Turnovers & Inspections', cat: 'turnover', createdBy: 'marcus', createdDay: d('2024-05-06'), members: ['marcus', 'jordan', 'kevin', 'luis', 'tasha', 'chloe'], description: 'Move-out → list in 10 days. Annual inspections live here too.' });
    this.addList({ key: 'acct', name: 'Accounting & Rent', cat: 'acct', createdBy: 'priya', createdDay: d('2024-04-20'), members: ['priya', 'amara', 'dana', 'sahil', 'lucas', 'isabel', 'noah'], description: 'Rent, deposits, vendor payments, month-end close.' });
    this.addList({ key: 'vendors', name: 'Vendors & Contracts', cat: 'vendors', createdBy: 'elena', createdDay: d('2024-05-14'), members: ['elena', 'marcus', 'kevin', 'priya', 'sahil'], description: 'Contracts, COIs, quotes and vendor onboarding.' });
    this.addList({ key: 'compliance', name: 'Compliance & Licenses', cat: 'compliance', createdBy: 'dana', createdDay: d('2024-06-03'), members: ['dana', 'elena', 'kevin', 'priya', 'sahil', 'tyler'], description: 'Licenses, inspections, lead certificates, filings.' });
    this.addList({ key: 'office', name: 'Office / Admin', cat: 'office', createdBy: 'dana', createdDay: d('2024-04-05'), members: ['dana', 'elena', 'marcus', 'priya', 'sahil', 'aisha', 'ryan', 'sofia'], description: 'Everything that is not a property.' });
    this.addList({ key: 'roof', name: 'Harbor View — 2025 Roof Replacement', cat: 'maint', createdBy: 'marcus', createdDay: d('2025-05-05'), members: ['marcus', 'luis', 'tasha', 'elena'], archivedAt: U.at(U.addDays(TODAY, -365), '10:30'), description: 'Sections A/B, Keystone Roofing. Closed out.' });
    // Personal "To do — <First name>" lists for every active employee except the brand-new hire.
    for (const m of this.members) {
      if (m.role !== 'employee' || !m.active || m.p.isNewHire) continue;
      const mgr = m.managerId ? this.members.find(x => x.id === m.managerId)! : this.M('dana');
      this.addList({ key: `todo_${m.key}`, name: `To do — ${m.first}`, cat: 'personal', createdBy: 'dana', createdDay: U.addDays(m.joinDay, this.rng.int(2, 5)), members: [m.key, mgr.key], defaultAssignee: m.key });
    }
    // Sahil's own list.
    this.addList({ key: 'todo_sahil', name: 'To do — Sahil', cat: 'personal', createdBy: 'dana', createdDay: d('2024-04-08'), members: ['sahil'], defaultAssignee: 'sahil' });
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  /** Completion instant for a done task: a few hours–days around the due day, after creation, before now. */
  completionFor(createdAt: Date, due: DayKey | null, hardBefore?: Date): Date | null {
    const latest = hardBefore ? U.minDate(hardBefore, U.plusMin(NOW, -90)) : U.plusMin(NOW, -90);
    let cand: Date;
    if (due) {
      const off = this.rng.weighted<number>([[-3, 1], [-2, 2], [-1, 4], [0, 8], [1, 5], [2, 3], [3, 2], [5, 1], [9, 1]]);
      cand = U.workInstant(this.rng, U.addDays(due, off));
    } else {
      cand = U.workInstant(this.rng, U.addDays(U.dayOf(createdAt), this.rng.int(1, 25)));
    }
    if (cand.getTime() < createdAt.getTime() + 30 * 60_000) cand = U.plusMin(createdAt, this.rng.int(45, 600));
    if (cand.getTime() > latest.getTime()) {
      if (latest.getTime() < createdAt.getTime() + 30 * 60_000) return null;
      cand = new Date(createdAt.getTime() + this.rng.next() * (latest.getTime() - createdAt.getTime() - 20 * 60_000) + 20 * 60_000);
    }
    return cand;
  }

  addTask(s: TaskSpec): TaskRow {
    const id = this.rng.uuid();
    const source = s.source || 'manual';
    const createdAt = s.createdAt;
    if (createdAt.getTime() > NOW.getTime() - 60_000) throw new Error('task created in the future');
    const assignee = s.assignee;
    let completedAt: Date | null = null;
    if (s.status === 'done') {
      completedAt = s.completedAt || this.completionFor(createdAt, s.due ?? null, assignee?.leftDay ? U.at(assignee.leftDay, '08:00') : undefined);
      if (!completedAt) throw new Error(`cannot complete task created at ${createdAt.toISOString()}`);
    }
    let archivedAt: Date | null = null;
    if (s.manualArchive) archivedAt = s.manualArchive.at;
    else if (completedAt && !s.deletedAt && !s.noAutoArchive && completedAt.getTime() < NOW.getTime() - 30 * U.DAY_MS) {
      archivedAt = U.nextArchiveTick(U.plusDays(completedAt, 30));
    }
    const lockedAt = s.lockedBy ? U.plusMin(createdAt, this.rng.int(30, 3 * 1440)) : null;
    const edits: Date[] = [createdAt];
    if (completedAt) edits.push(completedAt);
    if (archivedAt) edits.push(archivedAt);
    if (s.deletedAt) edits.push(s.deletedAt);
    if (lockedAt) edits.push(lockedAt);

    // Status history → audit rows + notifications, as the controller/service would have produced.
    const completer = completedAt ? (assignee && this.rng.chance(0.85) ? assignee : s.creator) : null;
    const url = `/?task=${id}`;
    if (!s.skipAudit) this.audit(s.creator, 'task.created', 'task', id, { title: s.title }, createdAt);
    // Only TasksService.create notifies the assignee; email ingestion, template apply and the recurrence worker do not.
    if (assignee && assignee.id !== s.creator.id && source === 'manual') {
      this.notify(assignee, 'task_assigned', 'task_assigned', `${s.creator.name} assigned you a task`, s.title, url, 'task', id, U.plusMin(createdAt, 0));
    }
    const statusStep = (status: string, at: Date, by: Member) => {
      this.audit(by, 'task.updated', 'task', id, { status }, at);
      edits.push(at);
      const recips = new Set<Member>();
      if (s.creator.id !== by.id) recips.add(s.creator);
      if (assignee && assignee.id !== by.id) recips.add(assignee);
      for (const r of recips) this.notify(r, 'task_status', 'task_status', `${by.name} moved a task to ${status}`, s.title, url, 'task', id, at);
    };
    const endBound = completedAt || (s.deletedAt ? s.deletedAt : NOW);
    if (s.status === 'done' && completedAt) {
      if (this.rng.chance(0.45) && completedAt.getTime() - createdAt.getTime() > 4 * 3_600_000) {
        statusStep('in_progress', new Date(createdAt.getTime() + (completedAt.getTime() - createdAt.getTime()) * this.rng.next() * 0.7 + 600_000), assignee || s.creator);
      }
      statusStep('done', completedAt, completer!);
    } else if (s.status === 'in_progress' || s.status === 'waiting_for') {
      if (endBound.getTime() - createdAt.getTime() > 3_600_000) {
        statusStep(s.status, new Date(createdAt.getTime() + (endBound.getTime() - createdAt.getTime()) * this.rng.next() * 0.8 + 900_000), assignee || s.creator);
      }
    }
    if (s.manualArchive) this.audit(s.manualArchive.by, 'task.archived', 'task', id, {}, s.manualArchive.at);

    const row: TaskRow = {
      id, workspaceId: this.wsId, listId: s.list.id, parentTaskId: s.parentTaskId || null, title: s.title.slice(0, 255), description: s.description ?? null,
      status: s.status, priority: s.priority || 'medium', creatorId: s.creator.id, assigneeId: assignee?.id ?? null, source, isLocked: !!s.lockedBy,
      lockedById: s.lockedBy?.id ?? null, lockedAt, startDate: s.startDay ? dateKeyToDb(s.startDay) : null, startTime: null,
      dueDate: s.due ? dateKeyToDb(s.due) : null, dueTime: s.dueTime ?? null, timezone: s.timezone === undefined ? s.creator.tz : s.timezone,
      completedAt, archivedAt, deletedAt: s.deletedAt || null, createdAt, updatedAt: new Date(Math.max(...edits.map(e => e.getTime()))),
    };
    this.tasks.push(row);
    this.taskList.set(id, s.list);
    if (s.checklist?.length) {
      s.checklist.forEach((c, i) => this.checklist.push({ id: this.rng.uuid(), taskId: id, text: c.text.slice(0, 500), isChecked: c.checked, sortOrder: i }));
    }
    return row;
  }

  /** Checklist with a checked-ratio that fits the status. */
  checklistFor(items: string[] | undefined, status: string, force = false): { text: string; checked: boolean }[] | undefined {
    if (!items || (!force && !this.rng.chance(0.55))) return undefined;
    const ratio = status === 'done' ? 1 : status === 'in_progress' ? this.rng.next() * 0.7 + 0.1 : status === 'waiting_for' ? 0.4 : this.rng.chance(0.7) ? 0 : 0.2;
    const n = Math.round(items.length * ratio);
    return items.map((text, i) => ({ text, checked: i < n }));
  }

  titleFor(cat: string): { title: string; description: string | null; priority: string; check?: string[] } {
    const tpl = this.rng.pick(C.TASK_TPL[cat] || C.TASK_TPL.personal);
    const sl = this.slots();
    const title = this.cap(U.fill(tpl.t, sl));
    const desc = tpl.d ? U.fill(tpl.d, sl) + (this.rng.chance(0.3) ? this.rng.pick(C.DESCRIPTION_EXTRAS) : '') : null;
    const priority = tpl.pri || this.rng.weighted<string>([['low', 2], ['medium', 6], ['high', 3], ['urgent', 0.6]]);
    return { title, description: desc || null, priority, check: tpl.check };
  }

  /** Quotas for the open-task due-date mix (spec: ~25 next 30 days, ~6 today, ~12 overdue). */
  quota = { next30: 25, today: 6, overdue: 12 };
  protectedIds = new Set<string>();

  openDue(): { due: DayKey | null; status: 'todo' | 'in_progress' | 'waiting_for' } {
    const status = this.rng.weighted<'todo' | 'in_progress' | 'waiting_for'>([['todo', 5], ['in_progress', 3], ['waiting_for', 2]]);
    let due: DayKey | null = null;
    const r = this.rng.next();
    if (this.quota.today > 0 && r < 0.08) { this.quota.today--; due = TODAY; }
    else if (this.quota.overdue > 0 && r < 0.22) { this.quota.overdue--; due = U.addDays(TODAY, -this.rng.weighted<number>([[1, 3], [3, 3], [7, 2], [15, 2], [40, 1], [95, 1]])); }
    else if (this.quota.next30 > 0 && r < 0.5) { this.quota.next30--; due = U.addDays(TODAY, this.rng.int(1, 30)); }
    else if (r < 0.62) due = U.addDays(TODAY, this.rng.int(31, 120));
    return { due, status };
  }

  /** Generate `count` tasks for a list from its template category. */
  populateList(l: ListRec, count: number, creators: string[], assignees: string[], opts: { forceOpen?: number; owner?: Member } = {}) {
    const picker = new U.DayPicker(l.createdDay, TODAY, TODAY);
    let made = 0, guard = 0;
    while (made < count && guard++ < count * 6) {
      const forceOpen = made < (opts.forceOpen || 0);
      let day = forceOpen ? U.businessDayBetween(this.rng, U.addDays(TODAY, -110), TODAY) : picker.pick(this.rng);
      if (day < l.createdDay) day = l.createdDay;
      const cPool = creators.map(k => this.M(k)).filter(m => this.activeOn(m, day));
      const aPool = assignees.map(k => this.M(k)).filter(m => this.activeOn(m, day));
      if (!cPool.length || !aPool.length) continue;
      let creator = this.rng.pick(cPool);
      let assignee = this.rng.pick(aPool);
      if (opts.owner) { // personal list: mostly the owner, sometimes the manager, assigned to the owner
        assignee = opts.owner;
        creator = this.rng.chance(0.55) ? opts.owner : this.rng.pick(cPool.filter(m => m.id !== opts.owner!.id).concat(opts.owner));
      }
      const createdAt = U.workInstant(this.rng, day);
      const ageDays = U.keyToDayNumber(TODAY) - U.keyToDayNumber(day);
      const t = this.titleFor(l.cat);
      const leaving = assignee.leftDay || creator.leftDay;
      let status: TaskSpec['status'] = 'done';
      let due: DayKey | null = null;
      if (!forceOpen && !leaving && (ageDays > 60 ? this.rng.chance(0.08) : this.rng.chance(0.55))) {
        const o = this.openDue(); status = o.status; due = o.due;
      } else if (forceOpen) {
        status = this.rng.weighted<TaskSpec['status']>([['todo', 6], ['in_progress', 3], ['waiting_for', 2]]);
        due = this.rng.chance(0.25) ? U.addDays(TODAY, this.rng.int(2, 60)) : null;
      } else {
        due = this.rng.chance(0.75) ? U.addDays(day, this.rng.int(1, 30)) : null;
        if (leaving) {
          const left = assignee.leftDay || creator.leftDay!;
          if (due && due >= left) due = U.addDays(left, -this.rng.int(2, 10));
        }
      }
      const dueTime = due && this.rng.chance(0.25) ? this.rng.pick(['09:00', '10:00', '12:00', '14:00', '17:00']) : null;
      const startDay = due && this.rng.chance(0.15) ? U.addDays(due, -this.rng.int(1, 7)) : null;
      const spec: TaskSpec = {
        list: l, title: t.title, description: t.description, creator, assignee, createdAt, due, dueTime, startDay, priority: t.priority, status,
        checklist: this.checklistFor(t.check, status),
      };
      try { this.addTask(spec); made++; } catch { /* could not place completion; retry */ }
    }
  }

  buildTasks() {
    const sh = (k: string) => this.L(k);
    this.populateList(sh('leasing'), 48, ['marcus', 'dana', 'jordan', 'kevin', 'elena', 'grace'], ['jordan', 'kevin', 'renee', 'grace', 'hannah', 'maya']);
    this.populateList(sh('oak'), 108, ['marcus', 'kevin', 'luis', 'tasha', 'chloe', 'elena'], ['luis', 'tasha', 'diego', 'samir', 'ethan'], { forceOpen: 64 });
    this.populateList(sh('hv'), 46, ['marcus', 'kevin', 'luis', 'tasha', 'elena'], ['luis', 'tasha', 'diego', 'samir']);
    this.populateList(sh('turn'), 40, ['marcus', 'jordan', 'kevin', 'chloe'], ['jordan', 'kevin', 'luis', 'tasha', 'chloe']);
    this.populateList(sh('acct'), 40, ['priya', 'dana', 'amara'], ['amara', 'priya', 'lucas', 'isabel', 'noah']);
    this.populateList(sh('vendors'), 24, ['elena', 'marcus', 'kevin'], ['kevin', 'marcus', 'elena', 'priya']);
    this.populateList(sh('compliance'), 22, ['dana', 'elena', 'tyler'], ['kevin', 'tyler', 'elena', 'priya']);
    this.populateList(sh('office'), 22, ['dana', 'elena', 'aisha'], ['aisha', 'ryan', 'sofia', 'elena', 'marcus', 'priya']);
    // Archived project list: everything done, long ago.
    {
      const l = sh('roof');
      const items = ['Engineer walk — decking review', 'Keystone contract signed', 'Permit pulled', 'Tenant notices — sections A/B', 'Dumpster + parking plan', 'Tear-off section A', 'Tear-off section B', 'Decking replacement (4 sheets)', 'Shingles + ridge vent', 'Gutter re-hang', 'County inspection', 'Final punch list + photos'];
      items.forEach((title, i) => {
        const day = U.addDays('2025-05-06', i * 9 + this.rng.int(0, 3));
        const assignee = this.M(i % 3 === 0 ? 'marcus' : i % 3 === 1 ? 'luis' : 'tasha');
        this.addTask({ list: l, title, description: i === 0 ? 'See the structural letter attached to the Vendors task.' : null, creator: this.M(i < 2 ? 'elena' : 'marcus'), assignee, createdAt: U.workInstant(this.rng, day), due: U.addDays(day, this.rng.int(3, 12)), priority: i >= 5 && i <= 8 ? 'high' : 'medium', status: 'done' });
      });
    }
    // Personal lists.
    for (const m of this.members) {
      if (m.role !== 'employee' || !m.active || m.p.isNewHire) continue;
      const l = this.L(`todo_${m.key}`);
      const mgrKey = m.p.managerKey || 'dana';
      const w = m.p.weight;
      const count = w >= 0.9 ? this.rng.int(22, 34) : w >= 0.6 ? this.rng.int(15, 20) : this.rng.int(4, 9);
      this.populateList(l, count, [m.key, mgrKey], [m.key], { owner: m });
    }
    const before = this.tasks.length;
    this.buildSahilTasks();
    this.buildEdgeCaseTasks();
    for (const t of this.tasks.slice(before)) this.protectedIds.add(t.id); // hand-crafted QA tasks: never trashed/archived at random
    this.buildTrashedAndArchived();
    this.buildSubtasks();
    this.buildEmailTasks();
    this.buildTemplateSourcedTasks();
  }

  /** Sahil (QA admin): 25 assigned (4 overdue, 3 today, 8 upcoming incl. 1 locked, 8 recent done, 1 archived, 1 trashed) + 10 created for others. */
  buildSahilTasks() {
    const s = this.M('sahil'), dana = this.M('dana'), elena = this.M('elena'), priya = this.M('priya'), marcus = this.M('marcus');
    const own = this.L('todo_sahil'), office = this.L('office'), acct = this.L('acct'), comp = this.L('compliance'), vend = this.L('vendors');
    const mk = (list: ListRec, title: string, desc: string | null, creator: Member, status: TaskSpec['status'], createdDaysAgo: number, due: DayKey | null, extra: Partial<TaskSpec> = {}) =>
      this.addTask({ list, title, description: desc, creator, assignee: s, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -createdDaysAgo)), due, status, priority: extra.priority || 'high', ...extra });
    // 4 overdue
    mk(comp, 'Sign the renewed Oakridge rental license application', 'County portal needs the owner e-signature before they will schedule the inspection.', dana, 'todo', 20, U.addDays(TODAY, -4));
    mk(acct, 'Approve Q3 owner distributions', 'Priya has the schedule ready; needs your approval before the wire goes out.', priya, 'waiting_for', 35, U.addDays(TODAY, -11));
    mk(vend, 'Review Keystone roofing contract — section C', 'Redlines from counsel are in. Decide on the gutter-guard add-on too.', elena, 'in_progress', 48, U.addDays(TODAY, -2));
    mk(own, 'Call the insurance broker about the umbrella policy', 'Renewal quote came in 18% higher. Ask about raising the deductible.', s, 'todo', 60, U.addDays(TODAY, -37), { priority: 'medium' });
    // 3 due today
    mk(own, 'Owner call prep — October numbers', 'Pull the KPI deck and the collections report.', s, 'in_progress', 3, TODAY, { dueTime: '14:00' });
    mk(office, 'Approve new-hire laptop order (Ben)', 'Same model as the techs. Aisha has the cart ready.', elena, 'todo', 2, TODAY, { priority: 'medium' });
    mk(acct, 'Confirm property tax payment — Harbor View', 'Due today at the county. Priya scheduled the ACH; confirm it posted.', priya, 'todo', 5, TODAY, { dueTime: '17:00' });
    // 8 upcoming (1 locked)
    mk(comp, 'Annual LLC report — Meridian Oakridge LLC', 'State portal; registered agent unchanged.', dana, 'todo', 6, U.addDays(TODAY, 3), { lockedBy: dana, priority: 'high' });
    mk(own, 'Review Cedar Lane refinance term sheet', 'Compare against the current note; 5-year fixed vs 7.', s, 'todo', 4, U.addDays(TODAY, 5));
    mk(vend, 'Decide: second HVAC vendor for Oakridge', 'ClearFlow backlog is hurting SLA. Marcus has two alternatives.', marcus, 'todo', 7, U.addDays(TODAY, 8), { priority: 'medium' });
    mk(office, 'Q4 KPI deck — review draft', 'Nadia will send the draft Monday.', s, 'todo', 1, U.addDays(TODAY, 12), { priority: 'medium' });
    mk(acct, 'Approve 2027 budget assumptions', '4% expense inflation, 3% rent growth — push back on insurance.', priya, 'waiting_for', 9, U.addDays(TODAY, 15));
    mk(own, 'Walk 2210 Walnut Ave with Omar', 'Acquisition candidate; bring the inspection checklist.', s, 'todo', 2, U.addDays(TODAY, 18), { dueTime: '10:00', startDay: U.addDays(TODAY, 18), priority: 'medium' });
    mk(comp, 'Lead certificate renewals — pre-1978 units', 'Tyler compiled the list; 6 units due before year end.', elena, 'in_progress', 14, U.addDays(TODAY, 24));
    mk(own, 'Read the new county notice-period ordinance', null, s, 'todo', 10, U.addDays(TODAY, 29), { priority: 'low' });
    // 8 done recently (not archived)
    const doneTitles: [ListRec, string, Member][] = [
      [own, 'Approve September owner statements', priya], [office, 'Sign off on the office internet renewal', elena], [acct, 'Review Oakridge insurance renewal quote', priya],
      [own, 'Send the LLC docs to the county', s], [vend, 'Approve GreenEdge landscaping scope change', marcus], [comp, 'Confirm backflow test certificates filed', dana],
      [own, 'Reply to the broker about 5 Quarry Rd', s], [office, 'Approve team lunch budget', dana],
    ];
    doneTitles.forEach(([list, title, creator], i) => {
      const ago = 3 + i * 3;
      const createdAt = U.workInstant(this.rng, U.addDays(TODAY, -ago - this.rng.int(2, 6)));
      const completedAt = U.workInstant(this.rng, U.addDays(TODAY, -ago));
      this.addTask({ list, title, description: null, creator, assignee: s, createdAt, due: U.addDays(TODAY, -ago + this.rng.int(0, 2)), status: 'done', completedAt, priority: 'medium' });
    });
    // 1 archived (completed 90 days ago → auto-archived by the worker)
    this.addTask({ list: own, title: 'Approve H1 capital projects list', description: 'Roofs, parking lots, water heaters by age.', creator: s, assignee: s, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -120)), due: U.addDays(TODAY, -92), status: 'done', completedAt: U.workInstant(this.rng, U.addDays(TODAY, -90)), priority: 'high' });
    // 1 trashed
    this.addTask({ list: own, title: 'Duplicate — call the broker (see other task)', description: null, creator: s, assignee: s, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -12)), due: null, status: 'todo', deletedAt: U.workInstant(this.rng, U.addDays(TODAY, -9)), priority: 'low' });
    // ~10 created by Sahil for others
    const forOthers: [ListRec, string, string, TaskSpec['status'], number, number | null][] = [
      [this.L('todo_nadia'), 'Draft the Q4 KPI deck', 'nadia', 'in_progress', 6, 12],
      [this.L('todo_nadia'), 'Refresh rent comps for all three properties', 'nadia', 'todo', 3, 9],
      [this.L('todo_nadia'), 'Build the 2027 budget model shell', 'nadia', 'done', 40, -22],
      [this.L('todo_omar'), 'Underwrite 2210 Walnut Ave', 'omar', 'in_progress', 8, 6],
      [this.L('todo_omar'), 'Pull the sold comps for 5 Quarry Rd', 'omar', 'done', 25, -15],
      [this.L('todo_omar'), 'Schedule the inspection — 2210 Walnut Ave', 'omar', 'todo', 2, 7],
      [acct, 'Send me the Q3 distribution schedule', 'priya', 'done', 38, -31],
      [office, 'Book the conference room for the owner call', 'ryan', 'done', 4, -2],
      [comp, 'Compile the list of pre-1978 units', 'tyler', 'done', 30, -20],
      [vend, 'Get two alternative HVAC vendor quotes', 'marcus', 'in_progress', 12, 5],
      [this.L('todo_kevin'), 'Send me the Harbor View unit spreadsheet', 'kevin', 'done', 16, -13],
    ];
    for (const [list, title, who, status, agoCreated, dueRel] of forOthers) {
      const a = this.M(who);
      const createdAt = U.workInstant(this.rng, U.addDays(TODAY, -agoCreated));
      const due = dueRel == null ? null : U.addDays(TODAY, dueRel);
      this.addTask({ list, title, description: null, creator: s, assignee: a, createdAt, due, status, priority: 'medium' });
    }
  }

  buildEdgeCaseTasks() {
    const hv = this.L('hv'), oak = this.L('oak'), vend = this.L('vendors'), acct = this.L('acct'), leasing = this.L('leasing');
    const marcus = this.M('marcus'), elena = this.M('elena'), luis = this.M('luis'), tasha = this.M('tasha'), priya = this.M('priya'), amara = this.M('amara');
    // 255-character title
    this.addTask({ list: hv, title: C.LONG_TITLE_255, description: 'Title length edge case — the full scope is in the description of the roof section C task.', creator: elena, assignee: marcus, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -5)), due: U.addDays(TODAY, 21), status: 'in_progress', priority: 'high' });
    // 2,000-char markdown-ish description + 12-item checklist
    this.addTask({ list: vend, title: 'Harbor View roof — section C scope and schedule', description: C.LONG_DESCRIPTION_2000, creator: elena, assignee: marcus, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -9)), due: U.addDays(TODAY, 26), status: 'in_progress', priority: 'high', checklist: C.BIG_CHECKLIST_12.map((text, i) => ({ text, checked: i < 3 })) });
    // Emoji / Spanish / Hindi titles and descriptions
    C.EMOJI_TITLES.forEach((title, i) => {
      const list = i % 3 === 0 ? oak : i % 3 === 1 ? hv : acct;
      const assignee = list === acct ? amara : i % 2 ? luis : tasha;
      const creator = list === acct ? priya : marcus;
      const desc = i === 3 ? C.SPANISH_DESC : i === 6 ? C.HINDI_DESC : null;
      const ago = this.rng.int(1, 40);
      const done = i % 4 === 1;
      this.addTask({ list, title, description: desc, creator, assignee, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -ago)), due: done ? U.addDays(TODAY, -Math.max(1, ago - 3)) : U.addDays(TODAY, this.rng.int(1, 14)), status: done ? 'done' : (i % 2 ? 'todo' : 'in_progress'), priority: i === 0 ? 'urgent' : 'medium', noAutoArchive: true });
    });
    // Open task assigned to someone who is NOT a member of the list (Luis in Leasing).
    this.addTask({ list: leasing, title: 'Fix the lockbox on Oakridge 2C before Saturday showings', description: 'Showings start 10am Saturday — the lockbox jams. Luis, please swap it.', creator: marcus, assignee: luis, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -5)), due: U.addDays(TODAY, 1), status: 'todo', priority: 'high' });
    // Three locked tasks (admin-locked), besides Sahil's.
    const dana = this.M('dana');
    this.addTask({ list: this.L('compliance'), title: 'Lead disclosure language — approved wording (do not edit)', description: 'Counsel-approved text for all leases. Locked.', creator: dana, assignee: this.M('kevin'), createdAt: U.workInstant(this.rng, U.addDays(TODAY, -200)), due: null, status: 'todo', priority: 'medium', lockedBy: dana });
    this.addTask({ list: acct, title: 'Security deposit escrow — account numbers and bank contact', description: 'Reference task. Locked by Dana.', creator: dana, assignee: priya, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -300)), due: null, status: 'todo', priority: 'low', lockedBy: dana });
    this.addTask({ list: this.L('office'), title: 'After-hours emergency protocol', description: 'Who to call, in what order. Locked — ask Elena to change.', creator: elena, assignee: marcus, createdAt: U.workInstant(this.rng, U.addDays(TODAY, -150)), due: null, status: 'in_progress', priority: 'high', lockedBy: elena });
  }

  buildTrashedAndArchived() {
    // 14 trashed in the last 3 weeks (plus Sahil's), mixed statuses.
    const candidates = this.tasks.filter(t => !t.deletedAt && !t.archivedAt && !t.isLocked && !t.parentTaskId && !this.protectedIds.has(t.id) && t.createdAt.getTime() < NOW.getTime() - 25 * U.DAY_MS);
    for (const t of this.rng.sample(candidates, 14)) {
      t.deletedAt = U.workInstant(this.rng, U.addDays(TODAY, -this.rng.int(0, 20)));
      if (t.deletedAt.getTime() < t.createdAt.getTime()) t.deletedAt = U.plusMin(t.createdAt, 60);
      t.updatedAt = U.maxDate(t.updatedAt, t.deletedAt);
    }
    // Three stale todo tasks archived by hand (audited), one of them later un-archived.
    const stale = this.rng.sample(this.tasks.filter(t => !t.deletedAt && !t.archivedAt && t.status === 'todo' && !t.isLocked && !this.protectedIds.has(t.id) && t.createdAt.getTime() < NOW.getTime() - 120 * U.DAY_MS && !this.taskList.get(t.id)!.key.startsWith('todo_')), 4);
    stale.forEach((t, i) => {
      const by = this.M(i % 2 ? 'marcus' : 'elena');
      const at = U.workInstant(this.rng, U.addDays(TODAY, -this.rng.int(10, 60)));
      this.audit(by, 'task.archived', 'task', t.id, {}, at);
      if (i === 3) { // un-archived two days later
        const back = U.plusDays(at, 2);
        this.audit(by, 'task.unarchived', 'task', t.id, {}, back);
        t.updatedAt = U.maxDate(t.updatedAt, back);
      } else {
        t.archivedAt = at; t.updatedAt = U.maxDate(t.updatedAt, at);
      }
    });
  }

  buildSubtasks() {
    const parents = this.rng.sample(this.tasks.filter(t => !t.parentTaskId && !t.deletedAt && !t.archivedAt && this.taskList.get(t.id)!.cat !== 'personal'), 18)
      .concat(this.rng.sample(this.tasks.filter(t => !t.parentTaskId && !t.deletedAt && t.archivedAt && t.status === 'done'), 6));
    let made = 0;
    for (const p of parents) {
      const list = this.taskList.get(p.id)!;
      const n = this.rng.int(1, 3);
      const members = list.memberKeys.map(k => this.M(k));
      for (let i = 0; i < n && made < 32; i++) {
        const createdAt = U.plusMin(p.createdAt, this.rng.int(5, 3 * 1440));
        if (createdAt.getTime() > NOW.getTime() - 3_600_000) break;
        const creator = this.members.find(m => m.id === p.creatorId)!;
        const pool = members.filter(m => this.activeAt(m, createdAt));
        const assignee = pool.length ? this.rng.pick(pool) : creator;
        const parentDone = p.status === 'done';
        const status: TaskSpec['status'] = parentDone ? 'done' : this.rng.weighted<TaskSpec['status']>([['todo', 5], ['in_progress', 2], ['done', 3]]);
        const completedAt = status === 'done' && parentDone ? new Date(createdAt.getTime() + 30 * 60_000 + (p.completedAt!.getTime() - createdAt.getTime() - 30 * 60_000) * this.rng.next()) : null;
        if (parentDone && completedAt && completedAt.getTime() <= createdAt.getTime()) continue;
        try {
          this.addTask({ list, title: this.rng.pick(C.SUBTASK_TPL), description: null, creator, assignee, createdAt, due: p.dueDate ? dbDateToKey(p.dueDate) : null, status, completedAt, priority: p.priority, parentTaskId: p.id });
          made++;
        } catch { /* skip */ }
      }
    }
  }

  buildEmailTasks() {
    const oak = this.L('oak');
    const senders: [string, string, string, string, number][] = [
      ['m.patel.oakridge@example.com', 'Meera Patel', 'No heat in unit 3B', 'Hi, the heat in 3B stopped working last night. The thermostat is on but nothing comes out of the vents. Please send someone today if possible.\n\nThanks,\nMeera', 2],
      ['r.okonkwo@example.net', 'Rob Okonkwo', 'Re: Garbage disposal 1A', 'It is jammed again. I tried the reset button. Can someone come by this week?\n\nRob', 9],
      ['fontaine.l@example.org', 'Lea Fontaine', 'Parking lot light out', 'The light by the east entrance has been out for a week. It is very dark coming home at night.', 33],
      ['bayside.dispatch@example.com', 'Bayside Plumbing', 'Scheduled: Oakridge water heater install Thursday', 'Confirming Thursday 8–12 window for the 40-gal install in 2D. Tech: Danny. Please ensure access.', 18],
    ];
    for (const [from, fromName, subject, text, ago] of senders) {
      const createdAt = U.anyInstant(this.rng, U.addDays(TODAY, -ago));
      const row = this.addTask({ list: oak, title: subject, description: text, creator: oak.createdBy, assignee: oak.defaultAssignee, createdAt, due: null, status: ago > 20 ? 'done' : 'todo', priority: 'medium', source: 'email', timezone: null, skipAudit: true, noAutoArchive: true });
      // EmailIngestionService stores only these fields (no headers/raw body/message ids).
      this.emailMeta.push({ id: this.rng.uuid(), taskId: row.id, fromAddress: from, toAddress: oak.inboundEmail, ccAddresses: [], subject, receivedAt: createdAt, createdAt });
      void fromName;
    }
  }

  buildTemplateSourcedTasks() {
    // Tasks applied from the "Unit turnover" task template (source=template, status todo on apply).
    const turn = this.L('turn'), jordan = this.M('jordan'), kevin = this.M('kevin');
    for (let i = 0; i < 6; i++) {
      const ago = this.rng.int(2, 160);
      const createdAt = U.workInstant(this.rng, U.addDays(TODAY, -ago));
      const p = this.rng.pick(C.PROPERTIES);
      const unit = C.unitLabel(p, this.rng.pick(p.units));
      const done = ago > 25;
      this.addTask({ list: turn, title: `Turnover — ${unit}`, description: 'From template: Unit turnover. Paint, clean, re-key, photos, list.', creator: i % 2 ? jordan : kevin, assignee: i % 2 ? kevin : jordan, createdAt, due: U.addDays(U.dayOf(createdAt), 10), status: done ? 'done' : 'in_progress', priority: 'high', source: 'template', skipAudit: true, checklist: this.checklistFor(['Move-out inspection', 'Re-key', 'Paint', 'Deep clean', 'Carpet clean', 'Photos', 'Punch list walk', 'List unit'], done ? 'done' : 'in_progress', true) });
    }
  }

  // ── recurrence ─────────────────────────────────────────────────────────
  addRule(cfg: {
    list: ListRec; title: string; description: string; creator: Member; assignee: Member; anchor: DayKey; createdDaysBeforeAnchor: number;
    frequency: string; interval?: number; daysOfWeek?: number[]; dayOfMonth?: number | null; endType?: string; endCount?: number | null;
    repeatAfterCompletion?: boolean; repeatDelayValue?: number | null; repeatDelayUnit?: string | null; checklist?: string[]; priority?: string; dueTime?: string | null;
    openTail?: number; // how many of the most recent past instances stay open
  }) {
    const ruleCreatedAt = U.workInstant(this.rng, U.addDays(cfg.anchor, -cfg.createdDaysBeforeAnchor));
    const sourceDone = cfg.anchor < TODAY;
    const src = this.addTask({
      list: cfg.list, title: cfg.title, description: cfg.description, creator: cfg.creator, assignee: cfg.assignee, createdAt: ruleCreatedAt, due: cfg.anchor,
      dueTime: cfg.dueTime ?? null, status: sourceDone ? 'done' : 'todo', priority: cfg.priority || 'medium',
      checklist: cfg.checklist ? cfg.checklist.map(t => ({ text: t, checked: sourceDone })) : undefined, noAutoArchive: false,
    });
    const ruleId = this.rng.uuid();
    const spec: RecurrenceSpec = {
      frequency: cfg.frequency, interval: cfg.interval ?? 1, daysOfWeek: cfg.daysOfWeek ?? [], dayOfMonth: cfg.dayOfMonth ?? null,
      endType: cfg.endType ?? 'never', endCount: cfg.endCount ?? null, endDate: null, repeatAfterCompletion: !!cfg.repeatAfterCompletion,
      repeatDelayValue: cfg.repeatDelayValue ?? null, repeatDelayUnit: cfg.repeatDelayUnit ?? null, anchor: cfg.anchor, generatedCount: 0,
    };
    const horizon = U.addDays(TODAY, 7);
    const srcChecklist = this.checklist.filter(c => c.taskId === src.id);
    let generated = 0, lastGenerated: Date | null = null, nextOcc: DayKey | null = null;
    const makeInstance = (occ: DayKey, earliest: Date, open: boolean, completedAt?: Date | null) => {
      // The hourly worker generates an occurrence once it is within 7 days (first tick after local midnight).
      const createdAt = U.minDate(U.maxDate(U.nextHourTick(U.at(U.addDays(occ, -7), '00:00')), U.nextHourTick(earliest)), U.plusMin(NOW, -5));
      const status: TaskSpec['status'] = open ? 'todo' : 'done';
      const row = this.addTask({
        list: cfg.list, title: cfg.title, description: cfg.description, creator: cfg.creator, assignee: cfg.assignee, createdAt, due: occ, dueTime: cfg.dueTime ?? null,
        status, completedAt: open ? null : completedAt ?? undefined, priority: cfg.priority || 'medium', source: 'recurring', timezone: U.TZ, skipAudit: true,
        checklist: srcChecklist.length ? srcChecklist.map(c => ({ text: c.text, checked: !open })) : undefined,
      });
      this.instances.push({ id: this.rng.uuid(), recurrenceRuleId: ruleId, taskId: row.id, occurrenceDate: dateKeyToDb(occ), isDetached: false, createdAt });
      generated++; spec.generatedCount = generated; lastGenerated = createdAt;
      return row;
    };
    if (cfg.repeatAfterCompletion) {
      // Driven by completion of the latest instance (or the source).
      // Waiting on an open instance → nextOccurrence stays null (the worker clears it).
      let basisCompleted: Date | null = src.completedAt;
      while (basisCompleted) {
        const next = nextOccurrence(spec, U.dayOf(basisCompleted));
        if (!next) break;
        if (next > horizon) { nextOcc = next; break; }
        const open = next >= U.addDays(TODAY, -2);
        const row = makeInstance(next, basisCompleted, open);
        basisCompleted = open ? null : row.completedAt;
      }
    } else {
      let cursor: DayKey | null = nextOccurrence(spec, cfg.anchor);
      let active = true;
      const tail = cfg.openTail ?? 0;
      const past: DayKey[] = [];
      while (cursor && cursor <= horizon) { past.push(cursor); spec.generatedCount = past.length; cursor = nextOccurrence(spec, cursor); }
      spec.generatedCount = 0;
      past.forEach((occ, i) => {
        const fromEnd = past.length - 1 - i;
        const open = occ >= TODAY || (fromEnd < tail && occ >= U.addDays(TODAY, -40));
        makeInstance(occ, ruleCreatedAt, open, null);
      });
      // cursor is now the first occurrence past the horizon (or null when the rule is exhausted) — what the worker stores.
      nextOcc = cursor;
      active = cursor != null;
      if (!active) nextOcc = null;
      this.rules.push(this.ruleRow(ruleId, src, cfg, spec, nextOcc, lastGenerated, active, ruleCreatedAt));
      return;
    }
    this.rules.push(this.ruleRow(ruleId, src, cfg, spec, nextOcc, lastGenerated, true, ruleCreatedAt));
  }

  private ruleRow(id: string, src: TaskRow, cfg: any, spec: RecurrenceSpec, nextOcc: DayKey | null, lastGenerated: Date | null, isActive: boolean, createdAt: Date) {
    // Sanity: the engine's own view of "next from today" must not be earlier than what we store for scheduled rules.
    const engineNext = computeNextFromRule(spec, NOW, U.TZ, src.completedAt ? U.dayOf(src.completedAt) : null);
    if (!cfg.repeatAfterCompletion && isActive && engineNext && nextOcc && engineNext > nextOcc) throw new Error(`rule ${cfg.title}: next ${nextOcc} precedes engine ${engineNext}`);
    return {
      id, taskId: src.id, workspaceId: this.wsId, frequency: cfg.frequency, interval: cfg.interval ?? 1, daysOfWeek: cfg.daysOfWeek ?? [], dayOfMonth: cfg.dayOfMonth ?? null,
      endType: cfg.endType ?? 'never', endCount: cfg.endType === 'after_count' ? cfg.endCount : null, endDate: null, timezone: U.TZ,
      repeatAfterCompletion: !!cfg.repeatAfterCompletion, repeatDelayValue: cfg.repeatDelayValue ?? null, repeatDelayUnit: cfg.repeatDelayUnit ?? null,
      nextOccurrence: nextOcc ? dateKeyToDb(nextOcc) : null, lastGenerated, isActive, createdAt, updatedAt: lastGenerated || createdAt,
    };
  }

  buildRecurrence() {
    this.addRule({ list: this.L('acct'), title: 'Send rent reminders & post late fees', description: 'Reminder texts on the 1st, late fees after the 5th grace period. Export the delinquency list for Priya.', creator: this.M('priya'), assignee: this.M('amara'), anchor: '2025-07-01', createdDaysBeforeAnchor: 12, frequency: 'monthly', dayOfMonth: 1, priority: 'high', checklist: ['Send reminder texts', 'Post late fees after the 5th', 'Export delinquency list'], dueTime: '09:00' });
    this.addRule({ list: this.L('oak'), title: 'Replace HVAC filters — all Oakridge units', description: 'Quarterly. 16 units; 20x25 upstairs, 16x25 downstairs. Note any unit that refuses entry.', creator: this.M('marcus'), assignee: this.M('luis'), anchor: '2024-07-15', createdDaysBeforeAnchor: 20, frequency: 'monthly', interval: 3, dayOfMonth: 15, checklist: ['Floor 1', 'Floor 2', 'Floor 3', 'Floor 4', 'Log refusals'], openTail: 1 });
    this.addRule({ list: this.L('hv'), title: 'Monday property walkthrough — Harbor View', description: 'Exterior walk: lights, trip hazards, dumpster area, signage. Photos of anything new.', creator: this.M('marcus'), assignee: this.M('tasha'), anchor: '2026-02-02', createdDaysBeforeAnchor: 4, frequency: 'weekly', daysOfWeek: [1], dueTime: '08:30', openTail: 2 });
    this.addRule({ list: this.L('compliance'), title: 'Renew county rental licenses — all properties', description: 'Annual renewal window opens Nov 1. Upload lead certs + inspection reports.', creator: this.M('dana'), assignee: this.M('dana'), anchor: '2024-11-15', createdDaysBeforeAnchor: 30, frequency: 'yearly', priority: 'high', checklist: ['Oakridge', 'Harbor View', 'Cedar Lane', 'Single-family'] });
    this.addRule({ list: this.L('hv'), title: 'Check Cedar Lane sump pumps after storm repairs', description: 'Bi-weekly check for 3 months after the drainage work. Float, discharge line, alarm.', creator: this.M('marcus'), assignee: this.M('luis'), anchor: '2025-03-05', createdDaysBeforeAnchor: 2, frequency: 'weekly', interval: 2, endType: 'after_count', endCount: 6 });
    this.addRule({ list: this.L('oak'), title: 'Deep-clean common areas — Oakridge lobby & halls', description: 'Repeats 3 weeks after each completion. Sparkle Clean standing order; walk it afterwards.', creator: this.M('kevin'), assignee: this.M('kevin'), anchor: '2026-01-10', createdDaysBeforeAnchor: 6, frequency: 'weekly', repeatAfterCompletion: true, repeatDelayValue: 3, repeatDelayUnit: 'weeks', priority: 'low' });
    // Sahil owns one.
    this.addRule({ list: this.L('office'), title: 'Monthly portfolio KPI review — all properties', description: 'Occupancy, collections, NOI vs budget, work-order SLA. Nadia prepares, Sahil reviews.', creator: this.M('sahil'), assignee: this.M('sahil'), anchor: '2026-04-05', createdDaysBeforeAnchor: 9, frequency: 'monthly', dayOfMonth: 5, priority: 'high', dueTime: '10:00' });
  }

  // ── comments ───────────────────────────────────────────────────────────
  addComment(task: TaskRow, author: Member, body: string, at: Date, mentioned: Member[] = []) {
    const id = this.rng.uuid();
    this.comments.push({ id, taskId: task.id, authorId: author.id, body, createdAt: at });
    const url = `/?task=${task.id}`;
    const targets = mentioned.filter(m => m.id !== author.id && this.activeAt(m, at));
    for (const m of targets) {
      this.mentions.push({ id: this.rng.uuid(), commentId: id, mentionedMemberId: m.id });
      this.notify(m, 'mention', 'mention', `${author.name} mentioned you`, `In "${task.title}"`, url, 'comment', id, at, m.key === 'sahil');
    }
    const mentionedIds = new Set(targets.map(m => m.id));
    const followers = [task.creatorId, task.assigneeId].filter((x): x is string => !!x && x !== author.id && !mentionedIds.has(x));
    for (const fid of new Set(followers)) {
      const f = this.members.find(m => m.id === fid)!;
      this.notify(f, 'task_comment', 'task_comment', `${author.name} commented`, `On "${task.title}": ${U.truncate(body)}`, url, 'comment', id, at, f.key === 'sahil');
    }
    this.taskFootprint.set(task.id, (this.taskFootprint.get(task.id) || 0) + 1);
    return id;
  }

  buildComments() {
    const eligible = this.tasks.filter(t => !t.deletedAt && t.source !== 'recurring' && !t.parentTaskId);
    const chosen = this.rng.sample(eligible, Math.round(eligible.length * 0.25));
    for (const t of chosen) {
      const list = this.taskList.get(t.id)!;
      const creator = this.members.find(m => m.id === t.creatorId)!;
      const assignee = t.assigneeId ? this.members.find(m => m.id === t.assigneeId)! : null;
      const mgr = assignee?.managerId ? this.members.find(m => m.id === assignee.managerId)! : null;
      const extra = list.memberKeys.map(k => this.M(k));
      const participants = Array.from(new Set([creator, assignee, mgr, this.rng.pick(extra)].filter((m): m is Member => !!m)));
      const end = t.completedAt || t.deletedAt || NOW;
      const span = end.getTime() - t.createdAt.getTime();
      if (span < 20 * 60_000) continue;
      const n = this.rng.weighted<number>([[1, 5], [2, 4], [3, 2], [4, 1]]);
      let cursor = t.createdAt.getTime() + 10 * 60_000 + this.rng.next() * span * 0.4;
      const sl = this.slots();
      let prevAuthor: Member | null = null;
      for (let i = 0; i < n; i++) {
        const at = new Date(Math.min(cursor, end.getTime() - 60_000));
        if (at.getTime() <= t.createdAt.getTime()) break;
        const pool = participants.filter(m => this.activeAt(m, at) && m.id !== prevAuthor?.id);
        if (!pool.length) break;
        const author = i === 0 && assignee && this.activeAt(assignee, at) && this.rng.chance(0.6) ? assignee : this.rng.pick(pool);
        let body: string, mentioned: Member[] = [];
        const others = participants.filter(m => m.id !== author.id && this.activeAt(m, at));
        if (i === 0) body = U.fill(this.rng.pick(C.COMMENT_TPL.opener), sl);
        else if (prevAuthor && this.rng.chance(0.5)) body = this.rng.pick(C.COMMENT_TPL.reply);
        else body = U.fill(this.rng.pick(C.COMMENT_TPL.opener), sl);
        if (others.length && this.rng.chance(i === 0 ? 0.25 : 0.4)) {
          const target = this.rng.pick(others);
          body = U.fill(this.rng.pick(C.COMMENT_TPL.mention), { ...sl, 'm:0': this.mention(target) });
          mentioned = [target];
        }
        this.addComment(t, author, body, at, mentioned);
        prevAuthor = author;
        cursor = at.getTime() + 15 * 60_000 + this.rng.next() * Math.max(span * 0.3, 3_600_000);
        if (cursor >= end.getTime()) break;
      }
    }
    // Eight comments that @mention Sahil on tasks he is on, recent, by his colleagues.
    const sahil = this.M('sahil');
    const sTasks = this.rng.sample(this.tasks.filter(t => !t.deletedAt && (t.assigneeId === sahil.id || t.creatorId === sahil.id) && t.createdAt.getTime() > NOW.getTime() - 60 * U.DAY_MS && !t.archivedAt), 8);
    sTasks.forEach((t, i) => {
      const author = this.M(['dana', 'priya', 'nadia', 'elena', 'marcus', 'omar', 'dana', 'priya'][i]);
      const start = Math.max(t.createdAt.getTime() + 20 * 60_000, NOW.getTime() - (14 - i) * U.DAY_MS);
      const at = new Date(Math.min(start + this.rng.next() * 6 * 3_600_000, NOW.getTime() - 30 * 60_000));
      if (at.getTime() <= t.createdAt.getTime()) return;
      const body = U.fill(this.rng.pick(C.COMMENT_TPL.sahil), { ...this.slots(), 'm:0': this.mention(sahil) });
      this.addComment(t, author, body, at, [sahil]);
      if (i < 3) this.addComment(t, sahil, this.rng.pick(C.COMMENT_TPL.reply), U.plusMin(at, this.rng.int(20, 300)), []);
    });
  }

  // ── attachments ────────────────────────────────────────────────────────
  attach(opts: { taskId?: string; messageId?: string; convId?: string; by: Member; at: Date; kind: 'png' | 'txt' | 'wav'; name: string; txt?: string }) {
    const body = opts.kind === 'png' ? this.rng.pick(this.pngs) : opts.kind === 'wav' ? this.wav : Buffer.from(opts.txt || 'demo', 'utf8');
    const mime = opts.kind === 'png' ? 'image/png' : opts.kind === 'wav' ? 'audio/wav' : 'text/plain';
    const key = opts.taskId ? `${this.wsId}/${opts.taskId}/${this.rng.uuid()}-${opts.name}` : `chat/${this.wsId}/${opts.convId}/${this.rng.uuid()}-${opts.name}`;
    const row = { id: this.rng.uuid(), workspaceId: this.wsId, taskId: opts.taskId || null, commentId: null, messageId: opts.messageId || null, uploadedById: opts.by.id, fileName: opts.name, fileSize: body.length, mimeType: mime, storageKey: key, createdAt: opts.at };
    this.attachments.push(row);
    this.uploads.set(key, { body, mime });
    return row;
  }

  buildTaskAttachments() {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
    const maint = this.tasks.filter(t => !t.deletedAt && ['maint', 'turnover'].includes(this.taskList.get(t.id)!.cat) && t.assigneeId);
    for (const t of this.rng.sample(maint, 24)) {
      const by = this.members.find(m => m.id === t.assigneeId)!;
      const end = t.completedAt || NOW;
      const n = this.rng.weighted<number>([[1, 6], [2, 3], [3, 1]]);
      for (let i = 0; i < n; i++) {
        const at = new Date(t.createdAt.getTime() + 60_000 + this.rng.next() * Math.max(end.getTime() - t.createdAt.getTime() - 120_000, 60_000));
        this.attach({ taskId: t.id, by, at, kind: 'png', name: `${slug(t.title) || 'photo'}-${i + 1}.png` });
      }
    }
    const acct = this.tasks.filter(t => !t.deletedAt && ['acct', 'vendors'].includes(this.taskList.get(t.id)!.cat));
    for (const t of this.rng.sample(acct, 10)) {
      const by = this.members.find(m => m.id === (t.assigneeId || t.creatorId))!;
      const sl = this.slots();
      const at = U.plusMin(t.createdAt, this.rng.int(5, 2880));
      if (at.getTime() > NOW.getTime()) continue;
      this.attach({ taskId: t.id, by, at, kind: 'txt', name: `invoice-${slug(sl.vendor)}.txt`, txt: C.INVOICE_TXT(sl.vendor, sl.amount, sl.prop) });
    }
    // Two voice-note attachments left on tasks.
    for (const t of this.rng.sample(maint.filter(t => t.createdAt.getTime() > NOW.getTime() - 40 * U.DAY_MS), 2)) {
      this.attach({ taskId: t.id, by: this.members.find(m => m.id === t.assigneeId)!, at: U.plusMin(t.createdAt, this.rng.int(10, 600)), kind: 'wav', name: `voice-${t.createdAt.getTime()}.wav` });
    }
  }

  // ── reminders ──────────────────────────────────────────────────────────
  relativeFire(t: TaskRow, value: number, unit: string): Date | null {
    if (!t.dueDate) return null;
    const due = localDateTimeToUtc(dbDateToKey(t.dueDate), t.dueTime || '09:00', U.TZ);
    return subtractOffset(due, value, unit);
  }

  buildReminders() {
    const mk = (t: TaskRow, member: Member, data: any) => this.reminders.push({ id: this.rng.uuid(), taskId: t.id, workspaceMemberId: member.id, type: 'exact', exactTime: null, relativeOffsetValue: null, relativeOffsetUnit: null, snoozedUntil: null, isFired: false, isDismissed: false, nextFireTime: null, isSmartSuggestion: false, suggestedReason: null, createdAt: t.createdAt, updatedAt: t.createdAt, ...data });
    const fireNotif = (t: TaskRow, m: Member, at: Date, force = false) => {
      const dueIn = t.dueDate ? Math.round((t.dueDate.getTime() - at.getTime()) / 60_000) : null;
      const body = t.dueDate ? (dueIn != null && dueIn > 0 ? `Due in ${dueIn < 60 ? dueIn + 'm' : dueIn < 1440 ? Math.round(dueIn / 60) + 'h' : Math.round(dueIn / 1440) + 'd'}` : 'Due now') : 'Reminder';
      this.notify(m, 'reminder', 'reminder', t.title, body, `/?task=${t.id}`, 'task', t.id, at, force);
    };
    const assigneeOf = (t: TaskRow) => this.members.find(m => m.id === t.assigneeId)!;
    const open = this.tasks.filter(t => !t.deletedAt && !t.archivedAt && t.status !== 'done' && t.assigneeId && t.assigneeId !== this.M('sahil').id);
    const done = this.tasks.filter(t => t.status === 'done' && t.assigneeId && t.completedAt && t.completedAt.getTime() < NOW.getTime() - 20 * U.DAY_MS && t.assigneeId !== this.M('sahil').id);
    // Exact reminders that fired long ago (some dismissed).
    for (const t of this.rng.sample(done, 14)) {
      const m = assigneeOf(t);
      const fireAt = U.plusMin(t.createdAt, this.rng.int(60, 5 * 1440));
      if (fireAt.getTime() > (t.completedAt || NOW).getTime()) continue;
      mk(t, m, { type: 'exact', exactTime: fireAt, nextFireTime: fireAt, isFired: true, isDismissed: this.rng.chance(0.4), updatedAt: fireAt });
      fireNotif(t, m, fireAt);
    }
    // Relative reminders on open tasks with a due date (fired if the instant has passed).
    for (const t of this.rng.sample(open.filter(t => t.dueDate), 12)) {
      const m = assigneeOf(t);
      const [v, u] = this.rng.pick<[number, string]>([[1, 'days'], [2, 'hours'], [30, 'minutes'], [3, 'days'], [1, 'hours']]);
      const fire = this.relativeFire(t, v, u)!;
      const fired = fire.getTime() < NOW.getTime();
      mk(t, m, { type: 'relative', relativeOffsetValue: v, relativeOffsetUnit: u, nextFireTime: fire, isFired: fired, updatedAt: fired ? fire : t.createdAt });
      if (fired) fireNotif(t, m, fire);
    }
    // Snoozed (2) and upcoming exact (5) on open tasks.
    const openRecent = open.filter(t => t.createdAt.getTime() > NOW.getTime() - 30 * U.DAY_MS);
    this.rng.sample(openRecent, 2).forEach(t => {
      const m = assigneeOf(t);
      const orig = U.plusMin(NOW, -this.rng.int(60, 1440));
      const until = U.plusMin(NOW, this.rng.int(60, 24 * 60));
      mk(t, m, { type: 'exact', exactTime: orig, snoozedUntil: until, nextFireTime: until, isFired: false, updatedAt: U.plusMin(orig, 5) });
    });
    this.rng.sample(openRecent, 5).forEach(t => {
      const m = assigneeOf(t);
      const when = U.at(U.addDays(TODAY, this.rng.int(1, 7)), this.rng.pick(['08:00', '09:00', '13:00']));
      mk(t, m, { type: 'exact', exactTime: when, nextFireTime: when });
    });
    // Two smart suggestions on overdue tasks.
    this.rng.sample(open.filter(t => t.dueDate && t.dueDate.getTime() < NOW.getTime() - U.DAY_MS), 2).forEach(t => {
      const when = U.at(U.addDays(TODAY, 1), '09:00');
      mk(t, assigneeOf(t), { type: 'exact', exactTime: when, nextFireTime: when, isSmartSuggestion: true, suggestedReason: 'This task is overdue. A reminder may help.', createdAt: U.plusMin(NOW, -600), updatedAt: U.plusMin(NOW, -600) });
    });
    // Sahil: upcoming, snoozed, fired, relative.
    const sahil = this.M('sahil');
    const sOpen = this.tasks.filter(t => !t.deletedAt && !t.archivedAt && t.status !== 'done' && t.assigneeId === sahil.id);
    const [a, b, c, d] = this.rng.sample(sOpen.filter(t => t.dueDate), 4);
    mk(a, sahil, { type: 'exact', exactTime: U.at(U.addDays(TODAY, 1), '08:30'), nextFireTime: U.at(U.addDays(TODAY, 1), '08:30') });
    mk(b, sahil, { type: 'exact', exactTime: U.plusMin(NOW, -200), snoozedUntil: U.plusMin(NOW, 180), nextFireTime: U.plusMin(NOW, 180), updatedAt: U.plusMin(NOW, -195) });
    const firedAt = U.plusMin(NOW, -this.rng.int(90, 600));
    mk(c, sahil, { type: 'exact', exactTime: firedAt, nextFireTime: firedAt, isFired: true, updatedAt: firedAt });
    fireNotif(c, sahil, firedAt, true);
    const rel = this.relativeFire(d, 1, 'days')!;
    mk(d, sahil, { type: 'relative', relativeOffsetValue: 1, relativeOffsetUnit: 'days', nextFireTime: rel, isFired: rel.getTime() < NOW.getTime(), updatedAt: rel.getTime() < NOW.getTime() ? rel : d.createdAt });
    if (rel.getTime() < NOW.getTime()) fireNotif(d, sahil, rel, true);
  }

  // ── overdue notifications (the 15-min worker, once per task per UTC day) ──
  buildOverdueNotifications() {
    const sahil = this.M('sahil');
    for (const t of this.tasks) {
      if (t.deletedAt || t.status === 'done' || !t.assigneeId || !t.dueDate) continue;
      const m = this.members.find(x => x.id === t.assigneeId)!;
      const dueKey = dbDateToKey(t.dueDate);
      let late = Math.round((U.keyToDayNumber(TODAY) - U.keyToDayNumber(dueKey)));
      if (late <= 0) continue;
      for (let d = 1; d <= late; d++) {
        const day = U.addDays(dueKey, d);
        if (day > TODAY) break;
        const at = U.at(day, '09:15');
        if (at.getTime() > NOW.getTime()) break;
        const force = m.id === sahil.id && d === late;
        this.notify(m, 'overdue', 'overdue', 'Task overdue', `${t.title} — ${d} day${d === 1 ? '' : 's'} late`, `/?task=${t.id}`, 'task', t.id, at, force);
      }
    }
  }

  // ── templates & views ──────────────────────────────────────────────────
  buildTemplatesAndViews() {
    const jordan = this.M('jordan'), kevin = this.M('kevin'), marcus = this.M('marcus'), elena = this.M('elena'), priya = this.M('priya'), sahil = this.M('sahil');
    const taskTpl = (title: string, priority: string, dueOff: number, items: string[], assignee?: Member) => ({
      title, description: null, priority, status: 'todo', defaultAssigneeMemberId: assignee?.id ?? null, dueDateOffsetDays: dueOff, startDateOffsetDays: null,
      checklistItems: items.map((text, i) => ({ text, sortOrder: i })),
    });
    const turnoverV3 = taskTpl('Turnover — unit', 'high', 10, ['Move-out inspection', 'Re-key', 'Paint', 'Deep clean', 'Carpet clean', 'Photos', 'Punch list walk', 'List unit'], kevin);
    const turnoverV2 = { ...turnoverV3, checklistItems: turnoverV3.checklistItems.slice(0, 6) };
    const turnoverV1 = { ...turnoverV3, dueDateOffsetDays: 14, checklistItems: turnoverV3.checklistItems.slice(0, 4) };
    const t0 = U.at('2024-06-10', '10:00');
    const push = (row: any) => this.templates.push({ id: this.rng.uuid(), workspaceId: this.wsId, versionHistory: [], version: 1, description: null, ...row });
    push({ type: 'task', name: 'Unit turnover', description: 'Standard 10-day turn.', createdById: marcus.id, visibility: 'workspace', data: turnoverV3, version: 4, createdAt: t0, updatedAt: U.at('2026-03-02', '15:20'),
      versionHistory: [
        { version: 3, data: { ...turnoverV3, checklistItems: turnoverV3.checklistItems.slice(0, 7) }, updatedAt: U.at('2025-08-19', '11:05') },
        { version: 2, data: turnoverV2, updatedAt: U.at('2025-01-14', '09:40') },
        { version: 1, data: turnoverV1, updatedAt: t0 },
      ] });
    push({ type: 'task', name: 'Move-in inspection', createdById: jordan.id, visibility: 'workspace', data: taskTpl('Move-in walkthrough — unit', 'medium', 0, ['Condition report', 'Photos uploaded', 'Keys & fobs', 'Welcome packet', 'Utilities transferred'], jordan), createdAt: U.at('2024-09-03', '14:00'), updatedAt: U.at('2024-09-03', '14:00') });
    push({ type: 'task', name: 'Vendor invoice approval', createdById: priya.id, visibility: 'personal', data: taskTpl('Pay invoice — vendor', 'medium', 25, ['Match PO', 'Code to property', 'Approve', 'Schedule payment']), createdAt: U.at('2025-02-11', '10:30'), updatedAt: U.at('2025-02-11', '10:30') });
    push({ type: 'list', name: 'New property onboarding', description: 'Everything to do in the first 30 days after closing.', createdById: elena.id, visibility: 'workspace', createdAt: U.at('2025-04-22', '09:00'), updatedAt: U.at('2025-04-22', '09:00'),
      data: { listName: 'Onboarding — property', listDescription: 'First 30 days after closing.', defaultAssigneeMemberId: kevin.id, tasks: [
        taskTpl('Register rental license', 'high', 10, ['Gather documents', 'Submit application', 'Pay fee'], kevin), taskTpl('Set up utilities in company name', 'high', 3, ['Electric', 'Water', 'Gas', 'Trash'], kevin),
        taskTpl('Add to insurance policy', 'high', 2, [], priya), taskTpl('Introduce ourselves to tenants', 'medium', 7, ['Letter', 'Portal invites'], jordan), taskTpl('Baseline inspection + photos', 'medium', 14, [], marcus),
      ] } });
    push({ type: 'list', name: 'Annual compliance calendar', createdById: sahil.id, visibility: 'personal', createdAt: U.at('2026-01-06', '16:10'), updatedAt: U.at('2026-01-06', '16:10'),
      data: { listName: 'Compliance — year', listDescription: null, defaultAssigneeMemberId: null, tasks: [taskTpl('Rental license renewals', 'high', 45, []), taskTpl('Backflow tests', 'medium', 120, []), taskTpl('Fire extinguisher tags', 'medium', 200, []), taskTpl('LLC annual reports', 'high', 90, [])] } });

    const view = (row: any) => this.views.push({ id: this.rng.uuid(), workspaceId: this.wsId, groupBy: null, ...row });
    view({ createdById: marcus.id, name: 'Overdue work orders', type: 'list', filters: { overdue: true, listId: this.L('oak').id }, sort: { sortBy: 'dueDate', sortOrder: 'asc' }, visibility: 'shared', createdAt: U.at('2025-03-18', '08:45'), updatedAt: U.at('2025-03-18', '08:45') });
    view({ createdById: priya.id, name: 'My high-priority this month', type: 'board', filters: { mine: true, priority: 'high', dueFrom: `${TODAY.slice(0, 7)}-01` }, sort: { sortBy: 'dueDate', sortOrder: 'asc' }, groupBy: 'status', visibility: 'personal', createdAt: U.at('2025-06-30', '12:00'), updatedAt: U.at('2026-02-02', '09:15') });
    view({ createdById: elena.id, name: 'Turnovers calendar', type: 'calendar', filters: { listId: this.L('turn').id, status: 'in_progress' }, sort: {}, visibility: 'shared', createdAt: U.at('2025-09-09', '10:00'), updatedAt: U.at('2025-09-09', '10:00') });
    view({ createdById: sahil.id, name: 'Waiting on me', type: 'list', filters: { mine: true, status: 'waiting_for' }, sort: { sortBy: 'createdAt', sortOrder: 'desc' }, visibility: 'personal', createdAt: U.at(U.addDays(TODAY, -20), '19:30'), updatedAt: U.at(U.addDays(TODAY, -20), '19:30') });
  }

  // ── chat ───────────────────────────────────────────────────────────────
  addConversation(name: string | null, memberKeys: string[], startDay: DayKey) {
    const members = memberKeys.map(k => this.M(k));
    // A conversation needs two people: it starts once the second-earliest joiner is in; later joiners are added as they arrive.
    const joins = members.map(m => m.joinDay).sort();
    const second = joins[1] ?? joins[0];
    const start = second > startDay ? second : startDay;
    const id = this.rng.uuid();
    const createdAt = U.workInstant(this.rng, start);
    const conv = { id, workspaceId: this.wsId, name, createdAt, lastMessageAt: null as Date | null, _members: members, _start: start, _msgs: [] as any[] };
    this.conversations.push(conv);
    for (const m of members) {
      // Later joiners are added early on their first day so nothing they say precedes their membership.
      const joinedAt = m.joinDay > start ? U.at(m.joinDay, '06:30') : createdAt;
      this.convMembers.push({ id: this.rng.uuid(), conversationId: id, workspaceMemberId: m.id, lastReadAt: null as Date | null, mutedUntil: null as Date | null, joinedAt, _m: m, _initial: m.joinDay <= start });
    }
    return conv;
  }

  addMessage(conv: any, sender: Member, body: string, at: Date, extra: any = {}) {
    const row = { id: this.rng.uuid(), conversationId: conv.id, senderId: sender.id, body, kind: 'text', replyToId: null, forwardedFromId: null, isPinned: false, deletedAt: null, createdAt: at, editedAt: null, ...extra };
    this.messages.push(row);
    conv._msgs.push(row);
    return row;
  }

  /** chat_message / chat_mention fan-out for a text message, honouring mutes and prefs. */
  notifyChat(conv: any, msg: any, sender: Member) {
    const emails = Array.from(new Set(Array.from(String(msg.body).matchAll(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g), (m: any) => m[1].toLowerCase())));
    const isGroup = !!conv.name;
    for (const cm of this.convMembers.filter(c => c.conversationId === conv.id)) {
      const r: Member = cm._m;
      if (r.id === sender.id) continue;
      if (cm.mutedUntil && cm._mutedAt && msg.createdAt.getTime() > cm._mutedAt.getTime()) continue;
      if (cm.joinedAt.getTime() > msg.createdAt.getTime()) continue;
      const mentioned = emails.includes(r.email.toLowerCase());
      const force = r.key === 'sahil' && msg.createdAt.getTime() > NOW.getTime() - 3 * U.DAY_MS;
      this.notify(r, mentioned ? 'chat_mention' : 'chat_message', mentioned ? 'mention' : 'chat', mentioned ? `${sender.name} mentioned you` : (isGroup ? `${conv.name} · ${sender.name}` : sender.name),
        U.truncate(msg.body || '(attachment)'), `/messages?c=${conv.id}`, 'message', msg.id, msg.createdAt, force);
    }
  }

  /** Play one scripted scene in a conversation on a given day. */
  playScene(conv: any, day: DayKey, scene: C.Scene, speakersIn?: Member[]) {
    const present: Member[] = (speakersIn || (conv._members as Member[])).filter((m: Member) => this.activeOn(m, day));
    if (present.length < Math.min(scene.roles, 2)) return [];
    const speakers = this.rng.sample(present, scene.roles);
    while (speakers.length < scene.roles) speakers.push(this.rng.pick(present));
    const sl = this.slots();
    let t = U.anyInstant(this.rng, day);
    const made: any[] = [];
    scene.lines.forEach(([ri, text], i) => {
      if (t.getTime() > NOW.getTime() - 60_000) return;
      const sender = speakers[ri];
      let body = U.fill(text, sl);
      // Occasionally @mention another participant.
      if (i > 0 && this.rng.chance(0.06)) {
        const other = this.rng.pick(present.filter((m: Member) => m.id !== sender.id));
        if (other) body = `${this.mention(other)} ${body}`;
      }
      const extra: any = {};
      if (i > 0 && made.length && this.rng.chance(0.14)) extra.replyToId = made[made.length - 1].id;
      const msg = this.addMessage(conv, sender, body, t, extra);
      made.push(msg);
      // Reactions from other participants.
      if (this.rng.chance(0.11)) {
        for (const r of this.rng.sample(present.filter((m: Member) => m.id !== sender.id), this.rng.int(1, 2))) {
          this.reactions.push({ id: this.rng.uuid(), messageId: msg.id, workspaceMemberId: r.id, emoji: this.rng.pick(C.REACTIONS), createdAt: U.plusMin(t, this.rng.int(1, 90)) });
        }
      }
      if (this.rng.chance(0.012)) msg.editedAt = U.plusMin(t, this.rng.int(1, 20));
      if (this.rng.chance(0.006)) { this.origBody.set(msg.id, msg.body); msg.deletedAt = U.plusMin(t, this.rng.int(1, 30)); msg.body = ''; }
      t = U.plusMin(t, this.rng.weighted<number>([[1, 5], [3, 5], [8, 4], [20, 3], [45, 2], [120, 1]]));
    });
    return made;
  }

  addCall(conv: any, caller: Member, callee: Member, at: Date, answered: boolean, about?: string) {
    const start = this.addMessage(conv, caller, 'Call started', at, { kind: 'call-start' });
    this.notify(callee, 'call_invite', 'call', 'Incoming call', `${caller.name} is calling…`, `/messages?c=${conv.id}`, 'conversation', conv.id, at, callee.key === 'sahil');
    if (answered) {
      const secs = this.rng.int(90, 1500);
      this.addMessage(conv, this.rng.chance(0.5) ? caller : callee, `Call ended (${Math.floor(secs / 60)}m ${secs % 60}s)`, new Date(at.getTime() + secs * 1000), { kind: 'call-end' });
    } else {
      this.addMessage(conv, caller, 'Call ended', new Date(at.getTime() + 28_000), { kind: 'call-end' });
      const text = this.addMessage(conv, caller, `Missed call — tried you about ${about || 'the ' + this.rng.pick(C.ISSUES)}`, U.plusMin(at, 1));
      this.notifyChat(conv, text, caller);
      this.notifiedMsg.add(text.id);
    }
    void start;
  }

  notifiedMsg = new Set<string>();
  origBody = new Map<string, string>();

  buildChat() {
    const dm = (a: string, b: string, start: DayKey, volume: number, themes: C.Scene['theme'][]) => ({ conv: this.addConversation(null, [a, b], start), volume, themes });
    const grp = (name: string, keys: string[], start: DayKey, volume: number, themes: C.Scene['theme'][]) => ({ conv: this.addConversation(name, keys, start), volume, themes });
    const allKeys = this.members.filter(m => !m.p.isNewHire).map(m => m.key);
    const convs = [
      grp('Maintenance crew', ['marcus', 'luis', 'tasha', 'kevin', 'diego', 'samir', 'ethan', 'victor'], '2024-04-20', 205, ['maint', 'general', 'turnover']),
      grp('Leadership', ['dana', 'elena', 'marcus', 'priya', 'sahil'], '2024-04-10', 120, ['lead', 'general', 'acct']),
      grp('Oakridge turnover — unit 3B', ['marcus', 'jordan', 'luis', 'kevin', 'tasha'], U.addDays(TODAY, -34), 58, ['turnover', 'maint']),
      grp('All hands — Meridian', allKeys, '2024-04-16', 150, ['general', 'lead']),
      dm('marcus', 'luis', '2024-04-18', 110, ['maint', 'general']),
      dm('marcus', 'tasha', '2024-09-12', 90, ['maint', 'general']),
      dm('marcus', 'jordan', '2024-04-22', 60, ['leasing', 'general']),
      dm('priya', 'amara', '2025-06-04', 80, ['acct', 'general']),
      dm('luis', 'tasha', '2024-09-20', 90, ['maint', 'general']),
      dm('jordan', 'kevin', '2025-03-12', 70, ['leasing', 'turnover', 'general']),
      dm('dana', 'elena', '2024-04-04', 50, ['lead', 'general']),
      dm('dana', 'marcus', '2024-04-05', 60, ['lead', 'maint', 'general']),
      dm('elena', 'priya', '2024-05-02', 30, ['acct', 'lead']),
      dm('sahil', 'dana', '2024-04-02', 42, ['lead', 'general']),
      dm('sahil', 'marcus', '2024-05-10', 36, ['lead', 'maint']),
      dm('sahil', 'nadia', '2025-01-15', 26, ['lead', 'acct', 'general']),
      dm('kevin', 'diego', '2025-04-25', 20, ['maint', 'general']),
      dm('marcus', 'renee', '2024-06-05', 25, ['leasing', 'general']),
    ];
    // Mute: Luis muted All hands (far future) three months ago. Set before any fan-out so no notifications land after that.
    const allHands = convs.find(c => c.conv.name === 'All hands — Meridian')!.conv;
    const luisAllHands = this.convMembers.find(cm => cm.conversationId === allHands.id && cm._m.key === 'luis')!;
    luisAllHands.mutedUntil = new Date('2099-01-01T00:00:00.000Z');
    luisAllHands._mutedAt = U.plusDays(NOW, -90);

    for (const { conv, volume, themes } of convs) {
      // A DM with someone who has since left ends the day before they left.
      let end: DayKey = TODAY;
      if (!conv.name) for (const m of conv._members as Member[]) if (m.leftDay && U.addDays(m.leftDay, -1) < end) end = U.addDays(m.leftDay, -1);
      const picker = new U.DayPicker(conv._start, end, TODAY);
      let guard = 0;
      while (conv._msgs.length < volume && guard++ < volume * 4) {
        let day = picker.pick(this.rng);
        if (day < conv._start) day = conv._start;
        if (this.rng.chance(0.22)) {
          const present = conv._members.filter((m: Member) => this.activeOn(m, day));
          if (present.length) this.addMessage(conv, this.rng.pick(present), this.rng.pick(C.FILLERS), U.anyInstant(this.rng, day));
          continue;
        }
        const pool = C.SCENES.filter(s => themes.includes(s.theme) && s.roles <= Math.max(2, conv._members.length));
        this.playScene(conv, day, this.rng.pick(pool));
      }
    }
    const byPair = (a: string, b: string) => convs.find(c => !c.conv.name && c.conv._members.some((m: Member) => m.key === a) && c.conv._members.some((m: Member) => m.key === b))!.conv;
    const byName = (n: string) => convs.find(c => c.conv.name === n)!.conv;

    // Calls: answered + missed, spread over time; one recent missed call to Sahil.
    const callPairs: [string, string][] = [['marcus', 'luis'], ['marcus', 'tasha'], ['dana', 'marcus'], ['luis', 'tasha'], ['jordan', 'kevin'], ['sahil', 'marcus'], ['sahil', 'dana']];
    for (let i = 0; i < 14; i++) {
      const [a, b] = this.rng.pick(callPairs);
      const conv = byPair(a, b);
      const day = U.businessDayBetween(this.rng, conv._start > '2025-06-01' ? conv._start : '2025-06-01', U.addDays(TODAY, -2));
      const caller = this.M(this.rng.chance(0.5) ? a : b), callee = this.M(caller.key === a ? b : a);
      this.addCall(conv, caller, callee, U.workInstant(this.rng, day), this.rng.chance(0.65));
    }
    this.addCall(byPair('sahil', 'marcus'), this.M('marcus'), this.M('sahil'), U.plusMin(NOW, -(26 * 60 + 13)), false, 'the Harbor View leak');
    this.addCall(byPair('marcus', 'luis'), this.M('luis'), this.M('marcus'), U.plusMin(NOW, -(3 * 60 + 40)), true);

    // Recent bursts that leave Sahil with unread messages in 2 DMs + 2 groups (last line by someone else).
    const dana = this.M('dana'), marcus = this.M('marcus'), elena = this.M('elena'), priya = this.M('priya'), sahil = this.M('sahil');
    const burst = (conv: any, lines: [Member, string][], startMinAgo: number) => {
      let t = U.plusMin(NOW, -startMinAgo);
      const made: any[] = [];
      for (const [m, text] of lines) { made.push(this.addMessage(conv, m, text, t)); t = U.plusMin(t, this.rng.int(2, 9)); }
      return made;
    };
    burst(byPair('sahil', 'dana'), [[sahil, 'Did the county come back on the Oakridge license?'], [dana, 'Not yet. I called — they say Monday.'], [dana, `${this.mention(sahil)} also, can you sign the renewed application today? It is in Compliance.`], [dana, 'And the umbrella policy quote is attached to your task 🙏']], 190);
    burst(byPair('sahil', 'marcus'), [[marcus, 'Second HVAC vendor quotes are in the Vendors task.'], [marcus, 'ClearFlow is 3 weeks out again. I would like to approve Brightline Mechanical for Oakridge.'], [marcus, 'Call me when you have 5 min']], 75);
    burst(byName('Leadership'), [[priya, 'Q3 distributions are ready for approval — task is assigned to Sahil.'], [elena, 'Keystone section C: counsel redlines are back, decision needed this week.'], [dana, `${this.mention(sahil)} ^ both of these are yours 🙂`], [marcus, 'Occupancy 96.3% as of this morning.']], 140);
    burst(byName('All hands — Meridian'), [[elena, 'Reminder: county inspector at Oakridge Friday 9am. Common areas spotless please.'], [this.M('kevin'), 'Sparkle Clean confirmed for Thursday afternoon.'], [this.M('luis'), '👍'], [this.M('aisha'), 'Welcome Ben to the maintenance team! 🎉'], [this.M('tasha'), 'Welcome!']], 50);

    // Pins (4), forwards (3), link previews (3), voice notes (6), image/file attachments (12) and one message with 5 attachments.
    const text = (c: any): any[] => c._msgs.filter((m: any) => m.kind === 'text' && !m.deletedAt && m.body);
    const pinTargets = [byName('Maintenance crew'), byName('Leadership'), byName('All hands — Meridian'), byPair('marcus', 'luis')];
    for (const c of pinTargets) { const m = this.rng.pick(text(c)); m.isPinned = true; }
    const fwd = (fromConv: any, toConv: any, who: Member, comment: string) => {
      const src = this.rng.pick(text(fromConv).filter((m: any) => m.createdAt.getTime() < NOW.getTime() - 2 * U.DAY_MS));
      const at = U.plusMin(src.createdAt, this.rng.int(10, 600));
      if (at.getTime() > NOW.getTime()) return;
      this.addMessage(toConv, who, comment, at, { forwardedFromId: src.id });
    };
    fwd(byPair('marcus', 'luis'), byName('Maintenance crew'), marcus, 'FYI from Luis');
    fwd(byName('Leadership'), byPair('sahil', 'dana'), dana, '');
    fwd(byPair('jordan', 'kevin'), byName('Oakridge turnover — unit 3B'), this.M('kevin'), 'Context for the 3B turn');
    const previews: [any, Member, string, any][] = [
      [byName('All hands — Meridian'), elena, 'New resident portal article is live: https://help.example-portal.com/articles/how-to-submit-a-maintenance-request', { url: 'https://help.example-portal.com/articles/how-to-submit-a-maintenance-request', title: 'How to submit a maintenance request', description: 'Step-by-step guide for residents.', siteName: 'Resident Help Center' }],
      [byName('Leadership'), priya, 'Good read on the late-fee cap changes: https://news.example-housing.org/2026/late-fee-caps-mid-atlantic', { url: 'https://news.example-housing.org/2026/late-fee-caps-mid-atlantic', title: 'Late-fee caps: what landlords need to know', description: 'A summary of the 2026 changes.', image: 'https://news.example-housing.org/img/late-fees.jpg', siteName: 'Housing News' }],
      [byName('Maintenance crew'), this.M('tasha'), 'This is the exhaust fan I keep recommending: https://shop.example-supply.com/p/quiet-80cfm-exhaust-fan', { url: 'https://shop.example-supply.com/p/quiet-80cfm-exhaust-fan', title: 'Quiet 80 CFM bathroom exhaust fan', siteName: 'Example Supply' }],
    ];
    for (const [c, who, body, lp] of previews) {
      const day = U.businessDayBetween(this.rng, U.addDays(TODAY, -60), U.addDays(TODAY, -1));
      const msg = this.addMessage(c, who, body, U.anyInstant(this.rng, day), { linkPreview: lp });
      void msg;
    }
    const voiceTargets = [byPair('marcus', 'luis'), byPair('luis', 'tasha'), byName('Maintenance crew'), byPair('marcus', 'tasha'), byPair('sahil', 'marcus'), byPair('jordan', 'kevin')];
    for (const c of voiceTargets) {
      const day = U.businessDayBetween(this.rng, U.addDays(TODAY, -45), U.addDays(TODAY, -1));
      const sender = this.rng.pick(c._members.filter((m: Member) => this.activeOn(m, day)));
      const at = U.anyInstant(this.rng, day);
      const msg = this.addMessage(c, sender, '', at);
      this.attach({ messageId: msg.id, convId: c.id, by: sender, at: U.plusMin(at, -1), kind: 'wav', name: `voice-${at.getTime()}.wav` });
      this.notifyChat(c, msg, sender);
    }
    const imgTargets = [byName('Maintenance crew'), byName('Maintenance crew'), byName('Maintenance crew'), byPair('marcus', 'luis'), byPair('marcus', 'luis'), byPair('luis', 'tasha'), byPair('luis', 'tasha'), byName('Oakridge turnover — unit 3B'), byPair('marcus', 'tasha'), byPair('kevin', 'diego'), byPair('priya', 'amara'), byPair('sahil', 'dana')];
    imgTargets.forEach((c, i) => {
      const day = U.businessDayBetween(this.rng, U.addDays(TODAY, -90), U.addDays(TODAY, -1));
      const sender = this.rng.pick(c._members.filter((m: Member) => this.activeOn(m, day)));
      const at = U.anyInstant(this.rng, day);
      const isInvoice = c === byPair('priya', 'amara') || c === byPair('sahil', 'dana');
      const msg = this.addMessage(c, sender, isInvoice ? 'Invoice attached' : this.rng.pick(['Before photo', 'After 👍', 'This is what I found behind the panel', 'Photo from today', 'See the stain here']), at);
      const sl = this.slots();
      this.attach({ messageId: msg.id, convId: c.id, by: sender, at: U.plusMin(at, -1), kind: isInvoice ? 'txt' : 'png', name: isInvoice ? `invoice-${i}.txt` : `IMG_${4100 + i * 7}.png`, txt: isInvoice ? C.INVOICE_TXT(sl.vendor, sl.amount, sl.prop) : undefined });
      this.notifyChat(c, msg, sender);
    });
    {
      const c = byName('Oakridge turnover — unit 3B'), jordan = this.M('jordan');
      const at = U.plusMin(NOW, -(2 * 1440 + 310));
      const msg = this.addMessage(c, jordan, 'Listing photos for 3B — 5 shots, let me know if the kitchen one is too dark', at);
      for (let i = 0; i < 5; i++) this.attach({ messageId: msg.id, convId: c.id, by: jordan, at: U.plusMin(at, -1), kind: 'png', name: `oakridge-3b-listing-${i + 1}.png` });
      this.notifyChat(c, msg, jordan);
    }

    // Chat notifications for scene/burst/preview text messages (attachment, voice and missed-call messages were fanned out above;
    // forwards never notify; call-start/call-end are system messages).
    const withAttachment = new Set(this.attachments.map(a => a.messageId).filter(Boolean));
    for (const { conv } of convs) {
      for (const m of conv._msgs) {
        if (m.kind !== 'text' || this.notifiedMsg.has(m.id) || m.forwardedFromId || withAttachment.has(m.id)) continue;
        const sender = this.members.find(x => x.id === m.senderId)!;
        const body = m.deletedAt ? this.origBody.get(m.id) || '' : m.body;
        if (!body) continue;
        this.notifyChat(conv, { ...m, body }, sender);
      }
    }

    // Finalise: sort messages, lastMessageAt, lastReadAt.
    const unreadForSahil = new Set([byPair('sahil', 'dana').id, byPair('sahil', 'marcus').id, byName('Leadership').id, byName('All hands — Meridian').id]);
    for (const { conv } of convs) {
      conv._msgs.sort((a: any, b: any) => a.createdAt.getTime() - b.createdAt.getTime());
      if (unreadForSahil.has(conv.id)) {
        // Guarantee the newest message is from someone other than Sahil so the conversation shows as unread for him.
        const tail = conv._msgs[conv._msgs.length - 1];
        if (tail && tail.senderId === sahil.id) {
          const other = this.rng.pick((conv._members as Member[]).filter(m => m.key !== 'sahil' && m.active));
          const at = U.minDate(U.plusMin(tail.createdAt, 3), U.plusMin(NOW, -2));
          const reply = this.addMessage(conv, other, this.rng.pick(['Will do.', 'On it 👍', 'Thanks — looking now.']), at);
          this.notifyChat(conv, reply, other);
          conv._msgs.sort((a: any, b: any) => a.createdAt.getTime() - b.createdAt.getTime());
        }
      }
      const last = conv._msgs[conv._msgs.length - 1];
      conv.lastMessageAt = last ? last.createdAt : null;
      // The conversation (and its founding members) must predate its first message.
      const first = conv._msgs[0];
      if (first && first.createdAt.getTime() <= conv.createdAt.getTime()) conv.createdAt = U.plusMin(first.createdAt, -1);
      for (const cm of this.convMembers.filter(c => c.conversationId === conv.id)) {
        const m: Member = cm._m;
        if (cm._initial) cm.joinedAt = conv.createdAt;
        if (!last) continue;
        if (m.key === 'sahil' && unreadForSahil.has(conv.id)) {
          // Read up to a few messages before the end.
          const idx = Math.max(0, conv._msgs.length - this.rng.int(3, 5));
          cm.lastReadAt = conv._msgs[idx].createdAt;
        } else if (m.leftDay) {
          const lastBefore = conv._msgs.filter((x: any) => x.createdAt.getTime() < U.at(m.leftDay!, '00:00').getTime()).pop();
          cm.lastReadAt = lastBefore ? U.plusMin(lastBefore.createdAt, 30) : null;
        } else if (this.rng.chance(0.85) || m.id === last.senderId) {
          cm.lastReadAt = U.plusMin(last.createdAt, this.rng.int(0, 240));
          if (cm.lastReadAt.getTime() > NOW.getTime()) cm.lastReadAt = U.plusMin(NOW, -1);
        } else {
          const idx = Math.max(0, conv._msgs.length - this.rng.int(1, 6));
          cm.lastReadAt = U.plusMin(conv._msgs[idx].createdAt, -1);
        }
      }
    }
    this.messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // ── read/unread post-processing ────────────────────────────────────────
  finaliseNotifications() {
    const sahil = this.M('sahil');
    for (const n of this.notifications) {
      const age = NOW.getTime() - n.createdAt.getTime();
      n.isRead = true;
      const delay = this.rng.weighted<number>([[5, 4], [30, 4], [180, 3], [1440, 2], [3 * 1440, 1]]) * 60_000 * (0.5 + this.rng.next());
      n.readAt = new Date(Math.min(n.createdAt.getTime() + delay, NOW.getTime() - 60_000));
      if (n.readAt.getTime() <= n.createdAt.getTime()) n.readAt = new Date(n.createdAt.getTime() + 60_000);
      void age;
    }
    // ~25 unread recent ones across non-Sahil members.
    const recentOthers = this.notifications.filter(n => n.recipientId !== sahil.id && n.createdAt.getTime() > NOW.getTime() - 4 * U.DAY_MS);
    for (const n of this.rng.sample(recentOthers, 25)) { n.isRead = false; n.readAt = null; }
    // Sahil: 12 unread of mixed types (most recent per type first).
    const mine = this.notifications.filter(n => n.recipientId === sahil.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const picked: any[] = [];
    const seen = new Set<string>();
    for (const n of mine) { if (!seen.has(n.type)) { seen.add(n.type); picked.push(n); } if (picked.length >= 12) break; }
    for (const n of mine) { if (picked.length >= 12) break; if (!picked.includes(n)) picked.push(n); }
    for (const n of picked) { n.isRead = false; n.readAt = null; }
  }

  // ── tokens ─────────────────────────────────────────────────────────────
  buildTokens() {
    for (const m of this.members) {
      if (m.key === 'sahil' || m.p.isNewHire) continue;
      const n = m.active ? this.rng.int(2, 4) : 2;
      for (let i = 0; i < n; i++) {
        const lastDay = m.leftDay ? U.addDays(m.leftDay, -1) : TODAY;
        const day = U.businessDayBetween(this.rng, m.joinDay, lastDay);
        const createdAt = U.anyInstant(this.rng, day);
        const expiresAt = U.plusDays(createdAt, 7);
        const current = m.active && i === n - 1 && this.rng.chance(0.7);
        this.refreshTokens.push({ id: this.rng.uuid(), userId: m.userId, tokenHash: sha256(this.rng.hex(40)), expiresAt: current ? U.plusDays(NOW, this.rng.int(2, 6)) : expiresAt, isRevoked: current ? false : (m.leftDay ? true : this.rng.chance(0.6)), userAgent: this.rng.pick(m.uas), ipAddress: this.rng.pick(m.ips), createdAt: current ? U.plusDays(NOW, -this.rng.int(1, 4)) : createdAt });
      }
    }
    // Password reset tokens: one valid + unused (raw token to the credentials file), one used months ago.
    const jordan = this.M('jordan'), kevin = this.M('kevin');
    const raw = randomBytes(32).toString('hex');
    this.secrets.resetToken = raw; this.secrets.resetEmail = jordan.email; this.secrets.resetExpires = U.plusMin(NOW, 60);
    this.resetTokens.push({ id: this.rng.uuid(), userId: jordan.userId, tokenHash: sha256(raw), expiresAt: this.secrets.resetExpires, usedAt: null, createdAt: U.plusMin(NOW, -1) });
    const usedAt = U.at(U.addDays(TODAY, -95), '08:12');
    this.resetTokens.push({ id: this.rng.uuid(), userId: kevin.userId, tokenHash: sha256(this.rng.hex(32)), expiresAt: U.plusMin(usedAt, 55), usedAt, createdAt: U.plusMin(usedAt, -5) });
  }

  // ── run ────────────────────────────────────────────────────────────────
  build(wsId: string) {
    this.wsId = wsId;
    this.buildMembers();
    this.buildInvitations();
    this.buildLists();
    this.buildTasks();
    this.buildRecurrence();
    this.buildComments();
    this.buildTaskAttachments();
    this.buildReminders();
    this.buildOverdueNotifications();
    this.buildTemplatesAndViews();
    this.buildChat();
    this.buildTokens();
    this.finaliseNotifications();
    this.audits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

// ───────────────────────────────────────────────────────────── reset

async function resetDemo(ws: { id: string }, storage: U.DemoStorage) {
  console.log(`SEED_DEMO_RESET=1 — removing demo workspace ${ws.id} …`);
  if (storage.isConfigured()) {
    const keys = await prisma.attachment.findMany({ where: { workspaceId: ws.id }, select: { storageKey: true } });
    for (const k of keys) await storage.delete(k.storageKey);
    console.log(`  deleted ${keys.length} R2 object(s)`);
  }
  // Explicit dependency order: several required relations (comment.author, task.creator, message.sender, …) are
  // Restrict, so a bare cascade from the workspace could be rejected mid-statement. Everything is scoped to this workspace.
  const w = { workspaceId: ws.id };
  const users = await prisma.$transaction(async tx => {
    const memberIds = (await tx.workspaceMember.findMany({ where: w, select: { id: true } })).map(m => m.id);
    const convIds = (await tx.conversation.findMany({ where: w, select: { id: true } })).map(c => c.id);
    await tx.notification.deleteMany({ where: w });
    await tx.auditLog.deleteMany({ where: w });
    await tx.attachment.deleteMany({ where: w });
    await tx.messageReaction.deleteMany({ where: { message: { conversationId: { in: convIds } } } });
    await tx.message.updateMany({ where: { conversationId: { in: convIds } }, data: { replyToId: null, forwardedFromId: null } });
    await tx.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await tx.conversationMember.deleteMany({ where: { conversationId: { in: convIds } } });
    await tx.conversation.deleteMany({ where: w });
    await tx.reminder.deleteMany({ where: { task: w } });
    await tx.mention.deleteMany({ where: { comment: { task: w } } });
    await tx.comment.deleteMany({ where: { task: w } });
    await tx.taskInstance.deleteMany({ where: { recurrenceRule: w } });
    await tx.recurrenceRule.deleteMany({ where: w });
    await tx.checklistItem.deleteMany({ where: { task: w } });
    await tx.taskEmailMetadata.deleteMany({ where: { task: w } });
    await tx.task.updateMany({ where: w, data: { parentTaskId: null } });
    await tx.task.deleteMany({ where: w });
    await tx.listMember.deleteMany({ where: { list: w } });
    await tx.list.deleteMany({ where: w });
    await tx.invitation.deleteMany({ where: w });
    await tx.template.deleteMany({ where: w });
    await tx.savedView.deleteMany({ where: w });
    await tx.pushSubscription.deleteMany({ where: { workspaceMemberId: { in: memberIds } } });
    await tx.deviceToken.deleteMany({ where: { workspaceMemberId: { in: memberIds } } });
    await tx.workspaceMember.updateMany({ where: w, data: { managerId: null } });
    await tx.workspaceMember.deleteMany({ where: w });
    await tx.workspace.delete({ where: { id: ws.id } });
    return tx.user.deleteMany({ where: { email: { endsWith: `@${C.DOMAIN}` }, workspaceMembers: { none: {} } } });
  }, { timeout: 300_000, maxWait: 20_000 });
  console.log(`  deleted workspace + ${users.count} demo user(s)`);
}

// ───────────────────────────────────────────────────────────── main

async function main() {
  const storage = new U.DemoStorage();
  const existing = await prisma.workspace.findFirst({ where: { slug: { startsWith: SLUG } }, select: { id: true, slug: true } });
  if (existing) {
    if (process.env.SEED_DEMO_RESET !== '1') {
      console.log(`Demo workspace already exists (slug ${existing.slug}). Nothing to do. Set SEED_DEMO_RESET=1 to delete and re-seed it.`);
      return;
    }
    await resetDemo(existing, storage);
  }

  const password = process.env.DEMO_PASSWORD || randomBytes(12).toString('base64url').slice(0, 16);
  const hash = await bcrypt.hash(password, 12);
  const wsId = new U.Rng(7).uuid();

  const result = await prisma.$transaction(async tx => {
    // Users first (ids come from the DB when a row already exists).
    const userIdByKey = new Map<string, string>();
    const eightMonthsAgo = U.dayNumberToKey(U.keyToDayNumber(TODAY) - 243);
    for (const p of C.PEOPLE) {
      const email = `${p.handle}@${C.DOMAIN}`;
      const joinDay = p.joinDay === 'NEW_HIRE' ? U.addDays(TODAY, -6) : p.joinDay;
      const createdAt = U.at(joinDay, '09:30');
      const u = await tx.user.upsert({
        where: { email },
        update: {},
        create: {
          email, name: p.name, authProvider: p.authProvider || 'email', passwordHash: p.authProvider === 'google' ? null : hash,
          isActive: true, createdAt, updatedAt: p.leftDay ? U.at(eightMonthsAgo, '10:12') : createdAt,
        },
        select: { id: true },
      });
      userIdByKey.set(p.key, u.id);
    }
    let sahil = await tx.user.findUnique({ where: { email: C.SAHIL_EMAIL }, select: { id: true, name: true } });
    let sahilCreated = false;
    if (!sahil) {
      sahil = await tx.user.create({ data: { email: C.SAHIL_EMAIL, name: 'QA Admin', authProvider: 'email', passwordHash: hash, createdAt: U.at(START_DAY, '09:00') }, select: { id: true, name: true } });
      sahilCreated = true;
    } else if (sahil.name === 'QA Admin') {
      // Our own placeholder from an earlier run on this (non-prod) DB: re-key it to this run's shared password.
      // A real account never carries this marker name, so it is never modified.
      await tx.user.update({ where: { id: sahil.id }, data: { passwordHash: hash } });
      sahilCreated = true;
    }

    const b = new Builder(sahil.id, sahil.name, userIdByKey);
    b.build(wsId);

    await tx.workspace.create({ data: { id: wsId, name: WS_NAME, slug: SLUG, settings: { timezone: U.TZ, autoArchiveDays: 30, trashRetentionDays: 30 }, createdAt: U.at(START_DAY, '09:00'), updatedAt: U.at('2025-01-10', '11:30') } });
    const many = async (name: string, rows: any[], fn: (data: any[]) => Promise<any>) => {
      for (const part of U.chunk(rows, 500)) await fn(part);
      return [name, rows.length] as [string, number];
    };
    const counts: [string, number][] = [];
    counts.push(await many('workspace_members', b.memberRows(), d => tx.workspaceMember.createMany({ data: d })));
    counts.push(await many('invitations', b.invitations, d => tx.invitation.createMany({ data: d })));
    counts.push(await many('lists', b.listRows(), d => tx.list.createMany({ data: d })));
    counts.push(await many('list_members', b.listMembers, d => tx.listMember.createMany({ data: d })));
    const parents = b.tasks.filter(t => !t.parentTaskId), subs = b.tasks.filter(t => t.parentTaskId);
    await many('tasks(parents)', parents, d => tx.task.createMany({ data: d }));
    counts.push(await many('tasks', subs, d => tx.task.createMany({ data: d })));
    counts[counts.length - 1][1] = b.tasks.length;
    counts.push(await many('task_email_metadata', b.emailMeta, d => tx.taskEmailMetadata.createMany({ data: d })));
    counts.push(await many('checklist_items', b.checklist, d => tx.checklistItem.createMany({ data: d })));
    counts.push(await many('recurrence_rules', b.rules, d => tx.recurrenceRule.createMany({ data: d })));
    counts.push(await many('task_instances', b.instances, d => tx.taskInstance.createMany({ data: d })));
    counts.push(await many('comments', b.comments, d => tx.comment.createMany({ data: d })));
    counts.push(await many('mentions', b.mentions, d => tx.mention.createMany({ data: d })));
    counts.push(await many('conversations', b.conversations.map(({ _members, _start, _msgs, ...c }) => c), d => tx.conversation.createMany({ data: d })));
    counts.push(await many('conversation_members', b.convMembers.map(({ _m, _mutedAt, _initial, ...c }) => c), d => tx.conversationMember.createMany({ data: d })));
    counts.push(await many('messages', b.messages, d => tx.message.createMany({ data: d })));
    counts.push(await many('message_reactions', b.reactions, d => tx.messageReaction.createMany({ data: d, skipDuplicates: true })));
    counts.push(await many('attachments', b.attachments, d => tx.attachment.createMany({ data: d })));
    counts.push(await many('reminders', b.reminders, d => tx.reminder.createMany({ data: d })));
    counts.push(await many('notifications', b.notifications, d => tx.notification.createMany({ data: d })));
    counts.push(await many('templates', b.templates, d => tx.template.createMany({ data: d })));
    counts.push(await many('saved_views', b.views, d => tx.savedView.createMany({ data: d })));
    counts.push(await many('audit_logs', b.audits, d => tx.auditLog.createMany({ data: d })));
    counts.push(await many('refresh_tokens', b.refreshTokens, d => tx.refreshToken.createMany({ data: d })));
    counts.push(await many('password_reset_tokens', b.resetTokens, d => tx.passwordResetToken.createMany({ data: d })));
    return { counts, uploads: b.uploads, secrets: b.secrets, sahilCreated, stats: summarise(b) };
  }, { timeout: 600_000, maxWait: 20_000 });

  // Files: real uploads when R2 is configured, otherwise rows only.
  let uploaded = 0, uploadNote = 'R2 env vars absent — attachment rows created with plausible storage keys; no files uploaded.';
  if (storage.isConfigured()) {
    for (const [key, f] of result.uploads) { await storage.upload(key, f.body, f.mime); uploaded++; }
    uploadNote = `uploaded ${uploaded} file(s) to R2 bucket ${process.env.R2_BUCKET_NAME || 'taskforge-files'}.`;
  }

  // Credentials file (never printed).
  const lines = [
    `# TaskForge demo credentials — generated ${NOW.toISOString()} (do not commit)`,
    `workspace: ${WS_NAME}  slug=${SLUG}  id=${wsId}`,
    `shared password (all @${C.DOMAIN} email users): ${password}`,
    `admins: dana.whitfield@${C.DOMAIN}, elena.marsh@${C.DOMAIN}, ${C.SAHIL_EMAIL}${result.sahilCreated ? ' (placeholder user created with the shared password)' : ' (existing account — use your own password)'}`,
    `managers: marcus.bell@${C.DOMAIN}, priya.natarajan@${C.DOMAIN}`,
    `google-only user (no password): grace.lin@${C.DOMAIN}`,
    `new hire (empty state): ben.kowalski@${C.DOMAIN}`,
    `deactivated: renee.caldwell@${C.DOMAIN}`,
    `pending invitation (valid ~5 days) raw token: ${result.secrets.inviteToken}`,
    `  accept URL path: /accept-invite/${result.secrets.inviteToken}`,
    `password reset token for ${result.secrets.resetEmail} (expires ${result.secrets.resetExpires!.toISOString()}, 60 min from seed time): ${result.secrets.resetToken}`,
    `  reset URL path: /auth/reset-password/${result.secrets.resetToken}`,
    '',
  ].join('\n');
  writeFileSync(CREDS_PATH, lines, { mode: 0o600 });
  try { chmodSync(CREDS_PATH, 0o600); } catch { /* windows */ }
  ensureGitignore();

  console.log(`\nSeeded "${WS_NAME}" (${SLUG})`);
  for (const [name, n] of result.counts) console.log(`  ${name.padEnd(24)} ${String(n).padStart(6)}`);
  console.log('\n' + result.stats);
  console.log(`\nFiles: ${uploadNote}`);
  console.log(`Credentials written to ${CREDS_PATH} (password + raw invite/reset tokens; not printed).`);
}

function summarise(b: Builder): string {
  const live = b.tasks.filter(t => !t.deletedAt && !t.archivedAt);
  const by = (f: (t: TaskRow) => boolean) => live.filter(f).length;
  const todayDb = dateKeyToDb(TODAY).getTime();
  const sahil = b.M('sahil');
  return [
    `tasks: ${b.tasks.length} total · live ${live.length} (done ${by(t => t.status === 'done')}, todo ${by(t => t.status === 'todo')}, in_progress ${by(t => t.status === 'in_progress')}, waiting_for ${by(t => t.status === 'waiting_for')})`,
    `       archived ${b.tasks.filter(t => t.archivedAt && !t.deletedAt).length} · trashed ${b.tasks.filter(t => t.deletedAt).length} · subtasks ${b.tasks.filter(t => t.parentTaskId).length} · recurring instances ${b.instances.length} · locked ${b.tasks.filter(t => t.isLocked).length}`,
    `       open overdue ${by(t => t.status !== 'done' && !!t.dueDate && t.dueDate.getTime() < todayDb)} · due today ${by(t => t.status !== 'done' && !!t.dueDate && t.dueDate.getTime() === todayDb)} · open due next 30d ${by(t => t.status !== 'done' && !!t.dueDate && t.dueDate.getTime() > todayDb && t.dueDate.getTime() <= todayDb + 30 * U.DAY_MS)}`,
    `members: ${b.members.length} (${b.members.filter(m => m.active).length} active) · lists ${b.lists.length} (${b.lists.filter(l => l.archivedAt).length} archived)`,
    `Sahil: assigned ${b.tasks.filter(t => t.assigneeId === sahil.id).length} · created ${b.tasks.filter(t => t.creatorId === sahil.id).length} · unread notifications ${b.notifications.filter(n => n.recipientId === sahil.id && !n.isRead).length} · mentions ${b.mentions.filter(m => m.mentionedMemberId === sahil.id).length}`,
    `notifications unread (all): ${b.notifications.filter(n => !n.isRead).length} · messages: ${b.messages.length} in ${b.conversations.length} conversations`,
  ].join('\n');
}

function ensureGitignore() {
  const gi = join(process.cwd(), '.gitignore');
  const line = '.demo-credentials.txt';
  if (!existsSync(gi)) { writeFileSync(gi, line + '\n'); return; }
  const cur = readFileSync(gi, 'utf8');
  if (!cur.split(/\r?\n/).includes(line)) appendFileSync(gi, (cur.endsWith('\n') ? '' : '\n') + line + '\n');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
