import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding TaskForge...\n');
  const hash = await bcrypt.hash('TestPass123!', 12);

  // Users
  const users = await Promise.all([
    prisma.user.upsert({ where: { email: 'sarah@acme.test' }, update: {}, create: { email: 'sarah@acme.test', passwordHash: hash, name: 'Sarah Chen', authProvider: 'email' } }),
    prisma.user.upsert({ where: { email: 'mike@acme.test' }, update: {}, create: { email: 'mike@acme.test', passwordHash: hash, name: 'Mike Johnson', authProvider: 'email' } }),
    prisma.user.upsert({ where: { email: 'alex@acme.test' }, update: {}, create: { email: 'alex@acme.test', passwordHash: hash, name: 'Alex Rivera', authProvider: 'email' } }),
    prisma.user.upsert({ where: { email: 'jordan@acme.test' }, update: {}, create: { email: 'jordan@acme.test', passwordHash: hash, name: 'Jordan Lee', authProvider: 'email' } }),
    prisma.user.upsert({ where: { email: 'taylor@acme.test' }, update: {}, create: { email: 'taylor@acme.test', passwordHash: hash, name: 'Taylor Smith', authProvider: 'email' } }),
  ]);
  const [sarah, mike, alex, jordan, taylor] = users;
  console.log('✓ Users');

  // Workspace
  const ws = await prisma.workspace.upsert({ where: { slug: 'acme-corp' }, update: {}, create: { name: 'Acme Corp', slug: 'acme-corp', settings: { autoArchiveDays: 30, trashRetentionDays: 30, smartRemindersEnabled: true } } });
  console.log('✓ Workspace');

  // Members
  const sm = await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: ws.id, userId: sarah.id } }, update: {}, create: { workspaceId: ws.id, userId: sarah.id, role: 'admin', timezone: 'America/New_York' } });
  const mm = await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: ws.id, userId: mike.id } }, update: {}, create: { workspaceId: ws.id, userId: mike.id, role: 'manager', timezone: 'America/Chicago', invitedBy: sm.id } });
  const am = await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: ws.id, userId: alex.id } }, update: {}, create: { workspaceId: ws.id, userId: alex.id, role: 'employee', managerId: mm.id, timezone: 'America/Los_Angeles', invitedBy: sm.id } });
  const jm = await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: ws.id, userId: jordan.id } }, update: {}, create: { workspaceId: ws.id, userId: jordan.id, role: 'employee', managerId: mm.id, timezone: 'America/New_York', invitedBy: sm.id } });
  const tm = await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: ws.id, userId: taylor.id } }, update: {}, create: { workspaceId: ws.id, userId: taylor.id, role: 'employee', managerId: mm.id, timezone: 'America/Denver', invitedBy: sm.id } });
  console.log('✓ Members');

  // Lists
  const listDefs = [
    { name: 'Product Launch', def: am.id, mems: [sm, mm, am, jm] },
    { name: 'Marketing', def: jm.id, mems: [sm, mm, jm, tm] },
    { name: 'Engineering', def: am.id, mems: [sm, mm, am, tm] },
    { name: 'Customer Support', def: tm.id, mems: [sm, mm, tm, jm] },
    { name: 'Company Operations', def: sm.id, mems: [sm, mm] },
  ];
  const lists = [];
  for (const ld of listDefs) {
    lists.push(await prisma.list.create({ data: { workspaceId: ws.id, name: ld.name, inboundEmail: `${uuidv4()}@inbound.taskforge.io`, inboundEmailEnabled: true, defaultAssigneeId: ld.def, createdById: sm.id, members: { create: ld.mems.map(m => ({ workspaceMemberId: m.id, addedById: sm.id })) } } }));
  }
  console.log('✓ Lists');

  // Tasks
  const now = new Date(), yd = new Date(now.getTime()-86400000), td2 = new Date(now.getTime()-2*86400000), tw = new Date(now.getTime()+86400000), nw = new Date(now.getTime()+7*86400000), d3 = new Date(now.getTime()+3*86400000);
  const taskDefs = [
    { li: 0, title: 'Finalize launch date with stakeholders', s: 'in_progress', p: 'urgent', c: sm.id, a: am.id, d: tw },
    { li: 0, title: 'Design landing page hero section', s: 'done', p: 'high', c: mm.id, a: am.id, d: yd },
    { li: 0, title: 'Write product announcement blog post', s: 'todo', p: 'high', c: mm.id, a: jm.id, d: d3 },
    { li: 0, title: 'Set up analytics tracking', s: 'waiting_for', p: 'medium', c: am.id, a: tm.id, d: nw },
    { li: 0, title: 'Create demo video script', s: 'todo', p: 'medium', c: sm.id, a: jm.id, d: td2 },
    { li: 0, title: 'Review pricing page copy', s: 'todo', p: 'low', c: mm.id, a: am.id, d: nw, locked: true },
    { li: 1, title: 'Draft Q2 marketing plan', s: 'in_progress', p: 'high', c: mm.id, a: jm.id, d: d3 },
    { li: 1, title: 'Update social media calendar', s: 'todo', p: 'medium', c: jm.id, a: tm.id, d: tw },
    { li: 1, title: 'Competitor analysis report', s: 'done', p: 'high', c: sm.id, a: jm.id, d: yd },
    { li: 2, title: 'Fix authentication race condition', s: 'in_progress', p: 'urgent', c: am.id, a: am.id, d: now },
    { li: 2, title: 'Implement WebSocket connection pooling', s: 'todo', p: 'high', c: mm.id, a: tm.id, d: d3 },
    { li: 2, title: 'Database query optimization', s: 'waiting_for', p: 'medium', c: sm.id, a: am.id, d: nw },
    { li: 2, title: 'Add unit tests for permission logic', s: 'todo', p: 'high', c: mm.id, a: am.id, d: td2 },
    { li: 2, title: 'Migrate to Node 20 LTS', s: 'done', p: 'medium', c: am.id, a: tm.id, d: yd },
    { li: 3, title: 'Create knowledge base: SSO setup', s: 'in_progress', p: 'medium', c: tm.id, a: tm.id, d: tw },
    { li: 3, title: 'Triage Q1 customer feedback', s: 'todo', p: 'high', c: mm.id, a: jm.id, d: d3 },
    { li: 3, title: 'Respond to Enterprise demo requests', s: 'in_progress', p: 'urgent', c: sm.id, a: tm.id, d: now },
    { li: 4, title: 'Update employee handbook', s: 'todo', p: 'medium', c: sm.id, a: sm.id, d: nw },
    { li: 4, title: 'Quarterly budget review', s: 'in_progress', p: 'high', c: sm.id, a: mm.id, d: d3 },
  ];
  const tasks = [];
  for (const t of taskDefs) {
    tasks.push(await prisma.task.create({ data: { workspaceId: ws.id, listId: lists[t.li].id, title: t.title, status: t.s as any, priority: t.p as any, creatorId: t.c, assigneeId: t.a, source: 'manual', dueDate: t.d, isLocked: t.locked || false, lockedById: t.locked ? sm.id : null, completedAt: t.s === 'done' ? yd : null } }));
  }
  console.log(`✓ ${tasks.length} Tasks`);

  // Comments
  await prisma.comment.createMany({ data: [
    { taskId: tasks[0].id, authorId: mm.id, body: 'VP of Product wants the 15th. @alex can you confirm landing page readiness?' },
    { taskId: tasks[0].id, authorId: am.id, body: 'Landing page 80% done. Final version by EOD tomorrow.' },
    { taskId: tasks[9].id, authorId: am.id, body: 'Found root cause — race condition in token refresh. Fix in progress.' },
    { taskId: tasks[16].id, authorId: tm.id, body: 'Three enterprise demos this week. @sarah should I loop in sales?' },
    { taskId: tasks[16].id, authorId: sm.id, body: 'Yes, cc the sales team on all enterprise demos.' },
  ]});
  console.log('✓ Comments');

  // Checklists
  for (const [i, text] of ['Confirm date with CEO', 'Notify marketing team', 'Update roadmap', 'Send calendar invites'].entries()) {
    await prisma.checklistItem.create({ data: { taskId: tasks[0].id, text, isChecked: i < 2, sortOrder: i } });
  }
  console.log('✓ Checklists');

  // Reminders
  await prisma.reminder.createMany({ data: [
    { taskId: tasks[0].id, workspaceMemberId: am.id, type: 'relative', relativeOffsetValue: 24, relativeOffsetUnit: 'hours', nextFireTime: now },
    { taskId: tasks[9].id, workspaceMemberId: am.id, type: 'exact', exactTime: tw, nextFireTime: tw },
    { taskId: tasks[4].id, workspaceMemberId: jm.id, type: 'exact', exactTime: now, nextFireTime: now, isSmartSuggestion: true, suggestedReason: 'This task is overdue. A reminder may help.' },
  ]});
  console.log('✓ Reminders');

  // Templates
  await prisma.template.createMany({ data: [
    { workspaceId: ws.id, type: 'task', name: 'Bug Report', createdById: am.id, visibility: 'workspace', data: { title: '[BUG] ', description: '## Steps to Reproduce\n1.\n\n## Expected\n\n## Actual\n', priority: 'high' }, version: 1, versionHistory: [] },
    { workspaceId: ws.id, type: 'list', name: 'Sprint Template', createdById: mm.id, visibility: 'workspace', data: { listName: 'Sprint {n}', tasks: ['Planning', 'Standups', 'Code review', 'Retro', 'Demo'] }, version: 1, versionHistory: [] },
  ]});
  console.log('✓ Templates');

  // Saved Views
  await prisma.savedView.createMany({ data: [
    { workspaceId: ws.id, createdById: sm.id, name: 'All Overdue', type: 'list', filters: { status: { not: 'done' }, dueDate: { lt: 'today' } }, sort: { dueDate: 'asc' }, visibility: 'shared' },
    { workspaceId: ws.id, createdById: mm.id, name: 'High Priority Board', type: 'board', filters: { priority: { in: ['high', 'urgent'] } }, sort: {}, visibility: 'shared' },
  ]});
  console.log('✓ Views');

  console.log('\n✅ Seed complete!');
  console.log('\nLogin: sarah@acme.test / TestPass123! (admin)');
  console.log('        mike@acme.test  / TestPass123! (manager)');
  console.log('        alex@acme.test  / TestPass123! (employee)');
  console.log(`Workspace: acme-corp`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
