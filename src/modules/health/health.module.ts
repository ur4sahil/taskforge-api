import { Controller, Get, Module, Res } from '@nestjs/common';
import { InjectQueue, BullModule } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Response } from 'express';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';

// GET /api/v1/health — for uptime probes. Checks the two dependencies whose
// failure makes the app useless (Postgres via the Supabase pooler, Redis for
// BullMQ) and answers 503 when either is down so a monitor can alert on status
// alone. Unauthenticated and deliberately boring: no versions, no hostnames.
const started = Date.now();
const PROBE_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_TIMEOUT_MS))]);
}

@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService, @InjectQueue('reminders') private q: Queue) {}

  @Public()
  @Get()
  async check(@Res() res: Response) {
    const [db, redis] = await Promise.all([
      withTimeout(this.prisma.$queryRaw`SELECT 1`).then(() => 'ok', () => 'fail'),
      withTimeout(this.q.client.then(c => c.ping())).then(() => 'ok', () => 'fail'),
    ]);
    const ok = db === 'ok' && redis === 'ok';
    res.status(ok ? 200 : 503).json({
      success: ok,
      data: { status: ok ? 'ok' : 'degraded', db, redis, uptimeSeconds: Math.round((Date.now() - started) / 1000) },
    });
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: 'reminders' })],
  controllers: [HealthController],
})
export class HealthModule {}
