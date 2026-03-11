import { Module, Logger } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '@/prisma/prisma.service';

@Processor('recurring-tasks') export class RecurringTaskProcessor extends WorkerHost {
  private log = new Logger('RecurringTasks');
  constructor(private prisma: PrismaService) { super(); }
  async process(job: Job) {
    const rules = await this.prisma.recurrenceRule.findMany({ where: { isActive: true, nextOccurrence: { lte: new Date(Date.now()+7*86400000) } }, include: { task: true } });
    for (const rule of rules) {
      if (!rule.nextOccurrence) continue;
      const exists = await this.prisma.taskInstance.findFirst({ where: { recurrenceRuleId: rule.id, occurrenceDate: rule.nextOccurrence } }); if (exists) continue;
      const t = await this.prisma.task.create({ data: { workspaceId: rule.workspaceId, listId: rule.task.listId, title: rule.task.title, description: rule.task.description, priority: rule.task.priority, assigneeId: rule.task.assigneeId, creatorId: rule.task.creatorId, source: 'recurring', status: 'todo', dueDate: rule.nextOccurrence, timezone: rule.timezone } });
      await this.prisma.taskInstance.create({ data: { recurrenceRuleId: rule.id, taskId: t.id, occurrenceDate: rule.nextOccurrence } });
      const next = new Date(rule.nextOccurrence); const iv = rule.interval;
      switch(rule.frequency) { case 'daily': next.setDate(next.getDate()+iv); break; case 'weekly': next.setDate(next.getDate()+7*iv); break; case 'monthly': next.setMonth(next.getMonth()+iv); break; case 'yearly': next.setFullYear(next.getFullYear()+iv); break; default: next.setDate(next.getDate()+iv); }
      await this.prisma.recurrenceRule.update({ where: { id: rule.id }, data: { nextOccurrence: next, lastGenerated: new Date() } });
      this.log.log(`Generated instance for rule ${rule.id}`);
    }
  }
}

@Processor('reminders') export class ReminderProcessor extends WorkerHost {
  private log = new Logger('Reminders');
  constructor(private prisma: PrismaService) { super(); }
  async process(job: Job) {
    const pending = await this.prisma.reminder.findMany({ where: { isFired: false, isDismissed: false, OR: [{ nextFireTime: { lte: new Date() } }, { snoozedUntil: { lte: new Date() } }] }, include: { task: true, workspaceMember: { include: { user: true } } } });
    for (const r of pending) {
      this.log.log(`Firing reminder ${r.id} for "${r.task.title}"`);
      await this.prisma.reminder.update({ where: { id: r.id }, data: { isFired: true, snoozedUntil: null } });
    }
  }
}

@Processor('overdue-check') export class OverdueProcessor extends WorkerHost {
  private log = new Logger('Overdue');
  constructor(private prisma: PrismaService) { super(); }
  async process(job: Job) {
    const overdue = await this.prisma.task.findMany({ where: { status: { not: 'done' }, dueDate: { lt: new Date() }, deletedAt: null }, include: { assignee: { include: { user: true } } } });
    for (const t of overdue) { const hrs = (Date.now()-(t.dueDate?.getTime()||0))/3600000; this.log.log(`Task ${t.id} overdue ${Math.round(hrs)}h`); }
  }
}

@Processor('auto-archive') export class AutoArchiveProcessor extends WorkerHost {
  private log = new Logger('AutoArchive');
  constructor(private prisma: PrismaService) { super(); }
  async process(job: Job) {
    const wss = await this.prisma.workspace.findMany({ select: { id: true, settings: true } });
    for (const ws of wss) { const days = ((ws.settings as any).autoArchiveDays)||30; const { count } = await this.prisma.task.updateMany({ where: { workspaceId: ws.id, status: 'done', completedAt: { lt: new Date(Date.now()-days*86400000) }, archivedAt: null, deletedAt: null }, data: { archivedAt: new Date() } }); if (count) this.log.log(`Archived ${count} in ${ws.id}`); }
  }
}

@Processor('trash-cleanup') export class TrashCleanupProcessor extends WorkerHost {
  private log = new Logger('TrashCleanup');
  constructor(private prisma: PrismaService) { super(); }
  async process(job: Job) {
    const wss = await this.prisma.workspace.findMany({ select: { id: true, settings: true } });
    for (const ws of wss) { const days = ((ws.settings as any).trashRetentionDays)||30; const { count } = await this.prisma.task.deleteMany({ where: { workspaceId: ws.id, deletedAt: { lt: new Date(Date.now()-days*86400000) } } }); if (count) this.log.log(`Purged ${count} from ${ws.id}`); }
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: 'recurring-tasks' }, { name: 'reminders' }, { name: 'overdue-check' }, { name: 'auto-archive' }, { name: 'trash-cleanup' }, { name: 'email-send' }, { name: 'push-notification' }, { name: 'daily-digest' }, { name: 'ai-query' }, { name: 'report-cache' })],
  providers: [RecurringTaskProcessor, ReminderProcessor, OverdueProcessor, AutoArchiveProcessor, TrashCleanupProcessor],
})
export class WorkersModule {}
