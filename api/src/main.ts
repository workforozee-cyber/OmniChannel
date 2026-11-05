import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './common/config';
import { q } from './common/db';
import { JobsService } from './jobs/jobs.service';

export async function createApp() {
  // rawBody: true keeps the exact bytes for webhook HMAC verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: config.env === 'test' ? false : undefined });
  app.use(helmet());
  app.enableCors({ origin: config.webOrigin.split(','), credentials: true });
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '5mb' });
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  createApp().then(async (app) => {
    await app.listen(config.port, process.env.HOST ?? '0.0.0.0');
    if (config.inProcessScheduler) startInProcessScheduler(app);
    Logger.log(`API listening on :${config.port} (jobs ${config.jobsInline ? 'inline' : 'via Redis/BullMQ worker'})`, 'Bootstrap');
  });
}

/**
 * Single-service hosting (e.g. Render free tier, no separate worker): run the scheduled jobs on timers here.
 * Jobs must also be inline (JOBS_INLINE=true). For larger installs use the separate worker (src/worker.ts) instead.
 */
function startInProcessScheduler(app: Awaited<ReturnType<typeof createApp>>) {
  const jobs = app.get(JobsService);
  const log = new Logger('Scheduler');
  const run = async (name: 'poll_orders' | 'reconcile', data: any) => {
    try { await jobs.handler(name)?.(data, 1); } catch (e: any) { log.warn(`${name} failed: ${e.message}`); }
  };
  setInterval(async () => {
    const live = await q(`SELECT id FROM marketplace_connections WHERE mode='live' AND status='connected'`).catch(() => []);
    for (const c of live) await run('poll_orders', { connectionId: c.id });
  }, config.orderPollMinutes * 60_000);
  setInterval(() => run('reconcile', {}), config.reconcileMinutes * 60_000);
  log.log(`In-process scheduler on: order polling every ${config.orderPollMinutes} min, reconciliation every ${config.reconcileMinutes} min`);
}
