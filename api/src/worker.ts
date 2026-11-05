import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { WorkerModule } from './app.module';
import { config } from './common/config';
import { q } from './common/db';
import { JobName, JobsService } from './jobs/jobs.service';

/**
 * Background worker. Run one or more of these alongside the API.
 *  - Consumes the 'omnichannel' BullMQ queue (publish, inventory/price sync, webhook processing, polling)
 *  - Schedules repeatable jobs: order polling per live connection, and full inventory reconciliation.
 */
async function main() {
  const log = new Logger('Worker');
  const ctx = await NestFactory.createApplicationContext(WorkerModule);
  const jobs = ctx.get(JobsService);
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker('omnichannel', async (job) => {
    const h = jobs.handler(job.name as JobName);
    if (!h) throw new Error(`No handler for ${job.name}`);
    await h(job.data, job.attemptsMade + 1);
  }, { connection, concurrency: 8 });
  worker.on('failed', (job, err) => log.warn(`${job?.name} failed (attempt ${job?.attemptsMade}): ${err.message}`));

  const queue = new Queue('omnichannel', { connection });
  const schedule = async () => {
    const live = await q(`SELECT id FROM marketplace_connections WHERE mode='live' AND status='connected'`);
    for (const c of live) {
      await queue.upsertJobScheduler(`poll:${c.id}`, { every: config.orderPollMinutes * 60_000 }, { name: 'poll_orders', data: { connectionId: c.id } });
    }
    await queue.upsertJobScheduler('reconcile', { every: config.reconcileMinutes * 60_000 }, { name: 'reconcile', data: {} });
  };
  await schedule();
  setInterval(() => schedule().catch((e) => log.error(e.message)), 5 * 60_000); // pick up newly connected accounts
  log.log('Worker started');

  const stop = async () => { await worker.close(); await queue.close(); await ctx.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main();
