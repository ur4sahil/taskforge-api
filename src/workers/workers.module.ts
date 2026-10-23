import { Module, Logger, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsModule, NotificationsService } from '../modules/notifications/notifications.module';
import { workspaceTimezone, todayKey, daysLate, dateKeyToDb, dbDateToKey } from '../common/utils/dates';
import { nextOccurrence, addDays, compareKeys, DayKey } from '../common/utils/recurrence';
import { specFromRule, ruleTimezone } from '../modules/recurrence/recurrence.module';

/** Instances are generated for occurrences up to this many days ahead (in the
 *  rule's timezone). */
export const RECURRENCE_HORIZON_DAYS = 7;
/** Runaway guard only: a rule whose nextOccurrence is years in the past keeps
 *  catching up on the next tick rather than holding this tick hostage. */
const MAX_INSTANCES_PER_RULE_PER_TICK = 1000;

type RuleWithTask = Prisma.RecurrenceRuleGetPayload<{ include: { task: { include: { checklistItems: true } } } }>;

/**
 * Hourly. For every active rule whose source task is neither trashed nor
 * archived, generates one Task + TaskInstance per occurrence from the stored
 * `nextOccurrence` up to today + 7 days in the rule's timezone — catching up
 * every missed occurrence in a single tick. Checklist items are copied
 * (unchecked); subtasks, comments and attachments are not. The
 * (recurrenceRuleId, occurrenceDate) unique index is the duplicate guard: a
 * P2002 means another tick already made that occurrence and is skipped.
 *
 * Repeat-after-completion rules are driven by the completion of the latest
 * instance (or of the source task before any instance exists): nothing is
 * generated until it is completed, then exactly one instance is scheduled the
 * configured delay after the completion day. While waiting, `nextOccurrence`
 * is null.
 */
@Processor('recurring-tasks')
export class RecurringTaskProcessor extends WorkerHost {
  private log = new Logger('RecurringTasks');
  constructor(private prisma: PrismaService) { super(); }

  async process(job: Job) {
    const now = new Date();
    // Superset by instant (the exact per-rule check is on calendar days below).
    const horizonInstant = new Date(now.getTime() + (RECURRENCE_HORIZON_DAYS + 1) * 86400000);
    const rules = await this.prisma.recurrenceRule.findMany({
      where: {
        isActive: true,
        // Only a trashed source stops the rule. Done tasks auto-archive after 30
        // days, and the source is usually completed as its first occurrence, so
        // requiring archivedAt: null would silently kill every rule a month in.
        task: { deletedAt: null },
        OR: [{ nextOccurrence: { lte: horizonInstant } }, { repeatAfterCompletion: true }],
      },
      include: { task: { include: { checklistItems: { orderBy: { sortOrder: 'asc' } } } } },
    });
    for (const rule of rules) {
      try {
        if (rule.repeatAfterCompletion) await this.processAfterCompletion(rule, now);
        else await this.processScheduled(rule, now);
      } catch (e: any) {
        this.log.error(`Rule ${rule.id}: ${e?.message || e}`);
      }
    }
  }

  private horizonFor(rule: RuleWithTask, now: Date): { today: DayKey; horizon: DayKey } {
    const today = todayKey(ruleTimezone(rule.timezone), now);
    return { today, horizon: addDays(today, RECURRENCE_HORIZON_DAYS) };
  }

  private async processScheduled(rule: RuleWithTask, now: Date) {
    if (!rule.nextOccurrence) return;
    const { horizon } = this.horizonFor(rule, now);
    let generated = await this.prisma.taskInstance.count({ where: { recurrenceRuleId: rule.id } });
    let cursor: DayKey | null = dbDateToKey(rule.nextOccurrence);
    let made = 0;
    while (cursor && compareKeys(cursor, horizon) <= 0 && made < MAX_INSTANCES_PER_RULE_PER_TICK) {
      if (await this.createInstance(rule, cursor)) { generated += 1; made += 1; }
      cursor = nextOccurrence(specFromRule(rule, rule.task, generated), cursor);
    }
    const stored = rule.nextOccurrence ? dbDateToKey(rule.nextOccurrence) : null;
    if (made === 0 && cursor === stored) return;
    await this.prisma.recurrenceRule.update({
      where: { id: rule.id },
      data: {
        nextOccurrence: cursor ? dateKeyToDb(cursor) : null,
        isActive: cursor != null,
        ...(made ? { lastGenerated: now } : {}),
      },
    });
    if (made) this.log.log(`Rule ${rule.id}: generated ${made} instance(s), next ${cursor ?? 'none (exhausted)'}`);
  }

  private async processAfterCompletion(rule: RuleWithTask, now: Date) {
    const tz = ruleTimezone(rule.timezone);
    const { horizon } = this.horizonFor(rule, now);
    // Most recently generated instance decides; before any exists, the source task.
    const latest = await this.prisma.taskInstance.findFirst({
      where: { recurrenceRuleId: rule.id },
      orderBy: { createdAt: 'desc' },
      include: { task: { select: { completedAt: true, deletedAt: true } } },
    });
    const basis = latest ? latest.task : rule.task;
    if (!basis || basis.deletedAt || !basis.completedAt) {
      if (rule.nextOccurrence && latest) {
        // Waiting on the latest instance; nothing is scheduled.
        await this.prisma.recurrenceRule.update({ where: { id: rule.id }, data: { nextOccurrence: null } });
      }
      return;
    }
    const generated = await this.prisma.taskInstance.count({ where: { recurrenceRuleId: rule.id } });
    const completedOn = todayKey(tz, basis.completedAt);
    const next = nextOccurrence(specFromRule(rule, rule.task, generated), completedOn);
    if (!next) {
      await this.prisma.recurrenceRule.update({ where: { id: rule.id }, data: { nextOccurrence: null, isActive: false } });
      return;
    }
    const nextDb = dateKeyToDb(next);
    if (compareKeys(next, horizon) > 0) {
      if (rule.nextOccurrence?.getTime() !== nextDb.getTime()) {
        await this.prisma.recurrenceRule.update({ where: { id: rule.id }, data: { nextOccurrence: nextDb } });
      }
      return;
    }
    const made = await this.createInstance(rule, next);
    await this.prisma.recurrenceRule.update({
      where: { id: rule.id },
      data: { nextOccurrence: null, ...(made ? { lastGenerated: now } : {}) },
    });
    if (made) this.log.log(`Rule ${rule.id}: generated after-completion instance for ${next}`);
  }

  /** Task + TaskInstance + checklist copy in one transaction. Returns false when
   *  the occurrence already existed (unique-index P2002), true when created. */
  private async createInstance(rule: RuleWithTask, day: DayKey): Promise<boolean> {
    const src = rule.task;
    const due = dateKeyToDb(day);
    try {
      await this.prisma.$transaction(async tx => {
        const t = await tx.task.create({
          data: {
            workspaceId: rule.workspaceId, listId: src.listId,
            title: src.title, description: src.description, priority: src.priority,
            assigneeId: src.assigneeId, creatorId: src.creatorId,
            source: 'recurring', status: 'todo',
            dueDate: due, dueTime: src.dueTime, timezone: rule.timezone,
          },
        });
        await tx.taskInstance.create({ data: { recurrenceRuleId: rule.id, taskId: t.id, occurrenceDate: due } });
        if (src.checklistItems.length) {
          await tx.checklistItem.createMany({
            data: src.checklistItems.map(c => ({ taskId: t.id, text: c.text, sortOrder: c.sortOrder, isChecked: false })),
          });
        }
      });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }
}

@Processor('reminders')
export class ReminderProcessor extends WorkerHost {
  private log = new Logger('Reminders');
  constructor(private prisma: PrismaService, private notifications: NotificationsService) { super(); }
  async process(job: Job) {
    const pending = await this.prisma.reminder.findMany({
      where: { isFired: false, isDismissed: false, OR: [{ nextFireTime: { lte: new Date() } }, { snoozedUntil: { lte: new Date() } }] },
      include: { task: { select: { id: true, title: true, workspaceId: true, dueDate: true } } },
    });
    for (const r of pending) {
      await this.prisma.reminder.update({ where: { id: r.id }, data: { isFired: true, snoozedUntil: null } });
      if (!r.task) continue;
      const due = r.task.dueDate ? new Date(r.task.dueDate) : null;
      const dueIn = due ? Math.round((due.getTime() - Date.now()) / 60000) : null;
      const body = due
        ? (dueIn != null && dueIn > 0 ? `Due in ${formatMinutes(dueIn)}` : 'Due now')
        : 'Reminder';
      await this.notifications.dispatch({
        workspaceId: r.task.workspaceId,
        recipientMemberId: r.workspaceMemberId,
        channel: 'reminder',
        type: 'reminder',
        title: r.task.title,
        body,
        url: `/?task=${r.task.id}`,
        entityType: 'task',
        entityId: r.task.id,
        suppressIfActiveScreen: `task:${r.task.id}`,
        pushTag: `reminder:${r.task.id}`,
      });
      this.log.log(`Fired reminder ${r.id} → member ${r.workspaceMemberId}`);
    }
  }
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 60 / 24)}d`;
}

@Processor('overdue-check')
export class OverdueProcessor extends WorkerHost {
  private log = new Logger('Overdue');
  constructor(private prisma: PrismaService, private notifications: NotificationsService) { super(); }
  async process(job: Job) {
    // Notify once per task per day. We rely on the 'overdue' notification.type with a date stamp
    // in metadata to dedupe — checked before dispatching. The dedupe day is UTC;
    // whether a task *is* overdue is judged against today in its workspace's
    // timezone (a task due today is not overdue at 9 pm Eastern).
    const dedupeDay = new Date().toISOString().slice(0, 10);
    const wss = await this.prisma.workspace.findMany({ select: { id: true, settings: true } });
    const todayByWs = new Map(wss.map(w => [w.id, todayKey(workspaceTimezone(w.settings))]));
    // Superset by UTC (anything due before tomorrow), then the exact per-workspace check.
    const candidates = await this.prisma.task.findMany({
      where: { status: { not: 'done' }, dueDate: { lt: new Date(Date.now() + 86400000) }, deletedAt: null },
      select: { id: true, title: true, workspaceId: true, assigneeId: true, dueDate: true },
    });
    for (const t of candidates) {
      if (!t.assigneeId || !t.dueDate) continue;
      const today = todayByWs.get(t.workspaceId);
      if (!today) continue;
      const late = daysLate(t.dueDate, today);
      if (late <= 0) continue;
      const already = await this.prisma.notification.findFirst({
        where: {
          workspaceId: t.workspaceId, recipientId: t.assigneeId, type: 'overdue',
          createdAt: { gte: new Date(dedupeDay) },
          data: { path: ['entityId'], equals: t.id },
        },
        select: { id: true },
      });
      if (already) continue;
      await this.notifications.dispatch({
        workspaceId: t.workspaceId,
        recipientMemberId: t.assigneeId,
        channel: 'overdue',
        type: 'overdue',
        title: 'Task overdue',
        body: `${t.title} — ${late} day${late === 1 ? '' : 's'} late`,
        url: `/?task=${t.id}`,
        entityType: 'task',
        entityId: t.id,
        suppressIfActiveScreen: `task:${t.id}`,
        pushTag: `overdue:${t.id}`,
      });
      this.log.log(`Notified overdue: ${t.id} → ${t.assigneeId}`);
    }
  }
}

@Processor('auto-archive')
export class AutoArchiveProcessor extends WorkerHost {
  private log = new Logger('AutoArchive');
  constructor(private prisma: PrismaService) { super(); }
  async process(job: Job) {
    const wss = await this.prisma.workspace.findMany({ select: { id: true, settings: true } });
    for (const ws of wss) {
      const days = ((ws.settings as any).autoArchiveDays) || 30;
      const { count } = await this.prisma.task.updateMany({ where: { workspaceId: ws.id, status: 'done', completedAt: { lt: new Date(Date.now() - days * 86400000) }, archivedAt: null, deletedAt: null }, data: { archivedAt: new Date() } });
      if (count) this.log.log(`Archived ${count} in ${ws.id}`);
    }
  }
}

@Processor('trash-cleanup')
export class TrashCleanupProcessor extends WorkerHost {
  private log = new Logger('TrashCleanup');
  constructor(private prisma: PrismaService) { super(); }
  async process(job: Job) {
    const wss = await this.prisma.workspace.findMany({ select: { id: true, settings: true } });
    for (const ws of wss) {
      const days = ((ws.settings as any).trashRetentionDays) || 30;
      const { count } = await this.prisma.task.deleteMany({ where: { workspaceId: ws.id, deletedAt: { lt: new Date(Date.now() - days * 86400000) } } });
      if (count) this.log.log(`Purged ${count} from ${ws.id}`);
    }
  }
}

@Injectable()
export class WorkerScheduler implements OnApplicationBootstrap {
  private log = new Logger('WorkerScheduler');
  constructor(
    @InjectQueue('recurring-tasks') private recurringQ: Queue,
    @InjectQueue('reminders') private remindersQ: Queue,
    @InjectQueue('overdue-check') private overdueQ: Queue,
    @InjectQueue('auto-archive') private archiveQ: Queue,
    @InjectQueue('trash-cleanup') private trashQ: Queue,
  ) {}

  async onApplicationBootstrap() {
    // In test, ioredis-mock can't service BullMQ's nested ioredis import; skip scheduling
    // so the suite doesn't dangle on background Redis retries.
    if (process.env.NODE_ENV === 'test') return;
    await this.schedule(this.remindersQ, 'reminders-tick', '* * * * *');
    await this.schedule(this.overdueQ, 'overdue-tick', '*/15 * * * *');
    await this.schedule(this.recurringQ, 'recurring-tick', '0 * * * *');
    await this.schedule(this.archiveQ, 'archive-tick', '0 3 * * *');
    await this.schedule(this.trashQ, 'trash-tick', '0 4 * * *');
    this.log.log('Repeatable jobs scheduled');
  }

  private async schedule(queue: Queue, name: string, pattern: string) {
    const existing = await queue.getRepeatableJobs();
    for (const r of existing) {
      if (r.name === name) await queue.removeRepeatableByKey(r.key);
    }
    await queue.add(name, {}, {
      repeat: { pattern },
      // The Supabase pooler drops connections for a few seconds several times a
      // day (Prisma P1001). Without retries every such tick was simply lost — a
      // missed reminder minute or overdue sweep. Three attempts at 30s / 60s /
      // 120s ride out the blip; a tick that fails all three is a real outage
      // and stays in the failed set for inspection.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    });
  }
}

@Module({
  imports: [
    NotificationsModule,
    BullModule.registerQueue(
      { name: 'recurring-tasks' },
      { name: 'reminders' },
      { name: 'overdue-check' },
      { name: 'auto-archive' },
      { name: 'trash-cleanup' },
    ),
  ],
  providers: [RecurringTaskProcessor, ReminderProcessor, OverdueProcessor, AutoArchiveProcessor, TrashCleanupProcessor, WorkerScheduler],
})
export class WorkersModule {}
