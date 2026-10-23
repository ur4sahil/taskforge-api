import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { bootstrapApp } from '../fixtures/app';
import { truncateAll, disconnect, prisma } from '../fixtures/db';
import { authHeader } from '../fixtures/auth';
import { seedWorkspace, createTask } from '../fixtures/factories';
import { RecurringTaskProcessor } from '../../src/workers/workers.module';
import { todayKey, dateKeyToDb, dbDateToKey } from '../../src/common/utils/dates';
import { addDays, weekday } from '../../src/common/utils/recurrence';

let app: INestApplication;
beforeAll(async () => { app = await bootstrapApp(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

const srv = () => app.getHttpServer();
const fakeJob = { name: 'tick', data: {} } as any;
const runProcessor = () => new RecurringTaskProcessor(prisma() as any).process(fakeJob);
// Rules in these tests are created with timezone 'UTC' so "today" and the
// stored @db.Date keys share a calendar and weekday assertions are stable.
const today = () => todayKey('UTC');

async function setup(dueKey?: string) {
  const { user, workspace, list, member } = await seedWorkspace();
  const task = await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, dueDate: dueKey ? dateKeyToDb(dueKey) : undefined });
  const headers = authHeader(user.id, user.email);
  const url = `/api/v1/workspaces/${workspace.id}/tasks/${task.id}/recurrence`;
  return { user, workspace, list, member, task, headers, url };
}

describe('Recurrence', () => {
  it('POST creates a recurrence rule and computes nextOccurrence', async () => {
    const { headers, url } = await setup('2030-06-01');
    const res = await request(srv()).post(url).set(headers).send({ frequency: 'weekly', interval: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.frequency).toBe('weekly');
    expect(res.body.data.interval).toBe(1);
    expect(res.body.data.isActive).toBe(true);
    expect(new Date(res.body.data.nextOccurrence).toISOString()).toBe('2030-06-08T00:00:00.000Z');
  });

  it('POST defaults the rule timezone to the workspace timezone (America/New_York)', async () => {
    const { headers, url } = await setup('2030-06-01');
    const res = await request(srv()).post(url).set(headers).send({ frequency: 'daily' });
    expect(res.status).toBe(201);
    expect(res.body.data.timezone).toBe('America/New_York');
  });

  it('POST on a task that already has an active rule → 409', async () => {
    const { headers, url } = await setup('2030-06-01');
    await request(srv()).post(url).set(headers).send({ frequency: 'weekly' }).expect(201);
    const res = await request(srv()).post(url).set(headers).send({ frequency: 'daily' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/already has a recurrence rule/i);
    expect(await prisma().recurrenceRule.count()).toBe(1);
  });

  it('POST after DELETE replaces the deactivated rule instead of 409', async () => {
    const { headers, url, task } = await setup('2030-06-01');
    await request(srv()).post(url).set(headers).send({ frequency: 'weekly' }).expect(201);
    await request(srv()).delete(url).set(headers).expect(200);
    const res = await request(srv()).post(url).set(headers).send({ frequency: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.data.frequency).toBe('monthly');
    expect(res.body.data.isActive).toBe(true);
    expect(new Date(res.body.data.nextOccurrence).toISOString()).toBe('2030-07-01T00:00:00.000Z');
    expect(await prisma().recurrenceRule.count({ where: { taskId: task.id } })).toBe(1);
  });

  it('PATCH updates frequency and recomputes nextOccurrence', async () => {
    const { headers, url } = await setup('2030-06-01');
    const created = await request(srv()).post(url).set(headers).send({ frequency: 'weekly', interval: 1 });
    expect(new Date(created.body.data.nextOccurrence).toISOString()).toBe('2030-06-08T00:00:00.000Z');

    const res = await request(srv()).patch(url).set(headers).send({ frequency: 'monthly' });
    expect(res.status).toBe(200);
    expect(res.body.data.frequency).toBe('monthly');
    expect(new Date(res.body.data.nextOccurrence).toISOString()).toBe('2030-07-01T00:00:00.000Z');

    const res2 = await request(srv()).patch(url).set(headers).send({ frequency: 'weekly', daysOfWeek: [3], interval: 2 });
    expect(res2.status).toBe(200);
    // Anchor Sat 2030-06-01; Wednesday of the week two weeks on.
    expect(new Date(res2.body.data.nextOccurrence).toISOString()).toBe('2030-06-12T00:00:00.000Z');
  });

  it('PATCH to an end that leaves no future occurrence → 400', async () => {
    const { headers, url } = await setup('2030-06-01');
    await request(srv()).post(url).set(headers).send({ frequency: 'weekly' }).expect(201);
    const res = await request(srv()).patch(url).set(headers).send({ endType: 'on_date', endDate: '2030-06-05' });
    expect(res.status).toBe(400);
  });

  it('DELETE deactivates (soft-removes) the rule', async () => {
    const { headers, url, task } = await setup('2030-06-01');
    await request(srv()).post(url).set(headers).send({ frequency: 'daily', interval: 1 }).expect(201);
    await request(srv()).delete(url).set(headers).expect(200);
    const rule = await prisma().recurrenceRule.findFirst({ where: { taskId: task.id } });
    expect(rule).not.toBeNull();
    expect(rule!.isActive).toBe(false);
  });

  describe('validation', () => {
    const bad: Array<[string, any]> = [
      ['unknown frequency', { frequency: 'fortnightly' }],
      ['unknown endType', { frequency: 'daily', endType: 'eventually' }],
      ['daysOfWeek out of range', { frequency: 'weekly', daysOfWeek: [1, 7] }],
      ['daysOfWeek not ints', { frequency: 'weekly', daysOfWeek: ['mon'] }],
      ['dayOfMonth 0', { frequency: 'monthly', dayOfMonth: 0 }],
      ['dayOfMonth 32', { frequency: 'monthly', dayOfMonth: 32 }],
      ['interval 0', { frequency: 'daily', interval: 0 }],
      ['after_count without endCount', { frequency: 'daily', endType: 'after_count' }],
      ['endCount 0', { frequency: 'daily', endType: 'after_count', endCount: 0 }],
      ['on_date without endDate', { frequency: 'daily', endType: 'on_date' }],
      ['endDate not a calendar day', { frequency: 'daily', endType: 'on_date', endDate: '2030-02-31' }],
      ['bogus timezone', { frequency: 'daily', timezone: 'Mars/Olympus' }],
      ['bogus repeatDelayUnit', { frequency: 'daily', repeatAfterCompletion: true, repeatDelayValue: 1, repeatDelayUnit: 'fortnights' }],
    ];
    it.each(bad)('rejects %s with 400', async (_n, body) => {
      const { headers, url } = await setup('2030-06-01');
      const res = await request(srv()).post(url).set(headers).send(body);
      expect(res.status).toBe(400);
      expect(await prisma().recurrenceRule.count()).toBe(0);
    });
  });

  describe('generation', () => {
    it('weekly Mon/Wed rule produces instances only on Mondays and Wednesdays', async () => {
      // Anchor is a past Monday; the rule starts from today.
      const { headers, url } = await setup('2026-01-05');
      await request(srv()).post(url).set(headers).send({ frequency: 'weekly', daysOfWeek: [1, 3], timezone: 'UTC' }).expect(201);

      await runProcessor();

      const instances = await prisma().taskInstance.findMany({ orderBy: { occurrenceDate: 'asc' } });
      // Exactly one Monday and one Wednesday fall in the 7 days after today.
      expect(instances).toHaveLength(2);
      for (const i of instances) {
        const key = dbDateToKey(i.occurrenceDate);
        expect([1, 3]).toContain(weekday(key));
        expect(key > today()).toBe(true);
        expect(key <= addDays(today(), 7)).toBe(true);
      }
      const tasks = await prisma().task.findMany({ where: { source: 'recurring' as any } });
      expect(tasks.map(t => dbDateToKey(t.dueDate!)).sort()).toEqual(instances.map(i => dbDateToKey(i.occurrenceDate)).sort());
      const rule = await prisma().recurrenceRule.findFirst({});
      expect([1, 3]).toContain(weekday(dbDateToKey(rule!.nextOccurrence!)));
      expect(dbDateToKey(rule!.nextOccurrence!) > addDays(today(), 7)).toBe(true);
    });

    it('after_count stops after endCount total occurrences (source task included) and deactivates the rule', async () => {
      const { headers, url } = await setup(addDays(today(), -1));
      await request(srv()).post(url).set(headers).send({ frequency: 'daily', endType: 'after_count', endCount: 3, timezone: 'UTC' }).expect(201);

      await runProcessor();
      let instances = await prisma().taskInstance.findMany({ orderBy: { occurrenceDate: 'asc' } });
      expect(instances.map(i => dbDateToKey(i.occurrenceDate))).toEqual([addDays(today(), 1), addDays(today(), 2)]);
      const rule = await prisma().recurrenceRule.findFirst({});
      expect(rule!.isActive).toBe(false);
      expect(rule!.nextOccurrence).toBeNull();
      expect(rule!.lastGenerated).not.toBeNull();

      await runProcessor();
      instances = await prisma().taskInstance.findMany({});
      expect(instances).toHaveLength(2);
    });

    it('on_date stops at the inclusive endDate', async () => {
      const { headers, url } = await setup(addDays(today(), -1));
      await request(srv()).post(url).set(headers).send({ frequency: 'daily', endType: 'on_date', endDate: addDays(today(), 2), timezone: 'UTC' }).expect(201);
      await runProcessor();
      const instances = await prisma().taskInstance.findMany({ orderBy: { occurrenceDate: 'asc' } });
      expect(instances.map(i => dbDateToKey(i.occurrenceDate))).toEqual([addDays(today(), 1), addDays(today(), 2)]);
      expect((await prisma().recurrenceRule.findFirst({}))!.isActive).toBe(false);
    });

    it('a soft-deleted source task stops generation', async () => {
      const { headers, url, task } = await setup(addDays(today(), -1));
      await request(srv()).post(url).set(headers).send({ frequency: 'daily', timezone: 'UTC' }).expect(201);
      await prisma().task.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
      await runProcessor();
      expect(await prisma().taskInstance.count()).toBe(0);
      expect(await prisma().task.count({ where: { source: 'recurring' as any } })).toBe(0);
    });

    it('an archived source task keeps generating (done sources auto-archive after 30 days)', async () => {
      const { headers, url, task } = await setup(addDays(today(), -1));
      await request(srv()).post(url).set(headers).send({ frequency: 'daily', timezone: 'UTC' }).expect(201);
      await prisma().task.update({ where: { id: task.id }, data: { status: 'done', completedAt: new Date(), archivedAt: new Date() } });
      await runProcessor();
      expect(await prisma().taskInstance.count()).toBe(7);
    });

    it('two processor runs do not duplicate instances', async () => {
      const { headers, url } = await setup(addDays(today(), -1));
      await request(srv()).post(url).set(headers).send({ frequency: 'daily', timezone: 'UTC' }).expect(201);
      await runProcessor();
      const first = await prisma().taskInstance.count();
      expect(first).toBe(7); // today+1 .. today+7
      await runProcessor();
      expect(await prisma().taskInstance.count()).toBe(first);
      expect(await prisma().task.count({ where: { source: 'recurring' as any } })).toBe(first);
    });

    it('unique-index path: a pre-existing instance for an occurrence is skipped without an orphan task', async () => {
      const { headers, url, task } = await setup(addDays(today(), -1));
      await request(srv()).post(url).set(headers).send({ frequency: 'daily', timezone: 'UTC' }).expect(201);
      const rule = await prisma().recurrenceRule.findFirst({});
      // Another tick "won" tomorrow's occurrence (points at the source task for brevity).
      await prisma().taskInstance.create({ data: { recurrenceRuleId: rule!.id, taskId: task.id, occurrenceDate: dateKeyToDb(addDays(today(), 1)) } });

      await runProcessor();

      const dates = (await prisma().taskInstance.findMany({})).map(i => dbDateToKey(i.occurrenceDate));
      expect(new Set(dates).size).toBe(dates.length);
      expect(dates).toHaveLength(7);
      // No recurring task was left behind for the day that already existed.
      expect(await prisma().task.count({ where: { source: 'recurring' as any, dueDate: dateKeyToDb(addDays(today(), 1)) } })).toBe(0);
      expect(await prisma().task.count({ where: { source: 'recurring' as any } })).toBe(6);
    });

    it('copies checklist items unchecked and the source dueTime; not subtasks', async () => {
      const { headers, url, task, workspace, list, member } = await setup(addDays(today(), -1));
      await prisma().task.update({ where: { id: task.id }, data: { dueTime: '14:30' } });
      await prisma().checklistItem.createMany({ data: [
        { taskId: task.id, text: 'A', sortOrder: 0, isChecked: true },
        { taskId: task.id, text: 'B', sortOrder: 1, isChecked: false },
      ] });
      await createTask({ workspaceId: workspace.id, listId: list.id, creatorId: member.id, title: 'sub' })
        .then(s => prisma().task.update({ where: { id: s.id }, data: { parentTaskId: task.id } }));
      await request(srv()).post(url).set(headers).send({ frequency: 'weekly', timezone: 'UTC' }).expect(201);

      await runProcessor();

      const made = await prisma().task.findMany({ where: { source: 'recurring' as any }, include: { checklistItems: { orderBy: { sortOrder: 'asc' } }, subtasks: true } });
      expect(made).toHaveLength(1);
      expect(made[0].dueTime).toBe('14:30');
      expect(made[0].checklistItems.map(c => [c.text, c.isChecked])).toEqual([['A', false], ['B', false]]);
      expect(made[0].subtasks).toHaveLength(0);
    });

    it('repeatAfterCompletion: nothing until the source task completes, then one instance after the delay', async () => {
      const { headers, url, task } = await setup(addDays(today(), -10));
      const res = await request(srv()).post(url).set(headers).send({ frequency: 'weekly', repeatAfterCompletion: true, timezone: 'UTC' });
      expect(res.status).toBe(201);
      expect(res.body.data.nextOccurrence).toBeNull();
      expect(res.body.data.isActive).toBe(true);

      await runProcessor();
      expect(await prisma().taskInstance.count()).toBe(0);

      // Completed 3 days ago → next = completion + 1 week = today + 4.
      await prisma().task.update({ where: { id: task.id }, data: { status: 'done', completedAt: new Date(dateKeyToDb(addDays(today(), -3)).getTime() + 12 * 3600000) } });
      await runProcessor();
      const instances = await prisma().taskInstance.findMany({});
      expect(instances).toHaveLength(1);
      expect(dbDateToKey(instances[0].occurrenceDate)).toBe(addDays(today(), 4));
      let rule = await prisma().recurrenceRule.findFirst({});
      expect(rule!.nextOccurrence).toBeNull(); // waiting on the new instance

      // The new instance is open → no further generation.
      await runProcessor();
      expect(await prisma().taskInstance.count()).toBe(1);

      // Complete the instance today → next = today + 7 (within horizon) → one more.
      await prisma().task.update({ where: { id: instances[0].taskId }, data: { status: 'done', completedAt: new Date() } });
      await runProcessor();
      const after = await prisma().taskInstance.findMany({ orderBy: { createdAt: 'asc' } });
      expect(after).toHaveLength(2);
      expect(dbDateToKey(after[1].occurrenceDate)).toBe(addDays(today(), 7));
      rule = await prisma().recurrenceRule.findFirst({});
      expect(rule!.isActive).toBe(true);
    });

    it('repeatAfterCompletion with an explicit delay beyond the horizon stores nextOccurrence and waits', async () => {
      const { headers, url, task } = await setup(addDays(today(), -1));
      await request(srv()).post(url).set(headers).send({ frequency: 'daily', repeatAfterCompletion: true, repeatDelayValue: 30, repeatDelayUnit: 'days', timezone: 'UTC' }).expect(201);
      await prisma().task.update({ where: { id: task.id }, data: { status: 'done', completedAt: new Date() } });
      await runProcessor();
      expect(await prisma().taskInstance.count()).toBe(0);
      const rule = await prisma().recurrenceRule.findFirst({});
      expect(dbDateToKey(rule!.nextOccurrence!)).toBe(addDays(today(), 30));
    });
  });
});
