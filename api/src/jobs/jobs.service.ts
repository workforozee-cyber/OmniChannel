import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../common/config';

export type JobName =
  | 'inventory_sync'   // { orgId, variantIds }
  | 'price_sync'       // { orgId, listingIds }
  | 'publish'          // { listingId }
  | 'listing_update'   // { listingId }
  | 'listing_status'   // { listingId, status }
  | 'webhook'          // { eventId }
  | 'poll_orders'      // { connectionId }
  | 'reconcile';       // { orgId? }

type Handler = (data: any, attempt: number) => Promise<void>;

/**
 * Background job façade.
 *  - Production: BullMQ on Redis. Workers run in a separate process (src/worker.ts) so API latency
 *    is unaffected by slow marketplace calls. Retries use exponential backoff.
 *  - JOBS_INLINE=true: handlers run in-process right away (tests / single-process dev).
 * Marketplace pushes are absolute ("set qty = N"), so retries and duplicates are harmless.
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private log = new Logger('Jobs');
  private handlers = new Map<JobName, Handler>();
  private queue: Queue | null = null;
  private conn: IORedis | null = null;
  inline = config.jobsInline;

  register(name: JobName, h: Handler) { this.handlers.set(name, h); }
  handler(name: JobName) { return this.handlers.get(name); }

  private getQueue() {
    if (!this.queue) {
      this.conn = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
      this.queue = new Queue('omnichannel', { connection: this.conn });
    }
    return this.queue;
  }

  async enqueue(name: JobName, data: any, opts: { delayMs?: number; jobId?: string } = {}) {
    if (this.inline) {
      const h = this.handlers.get(name);
      if (!h) throw new Error(`No handler for job ${name}`);
      try { await h(data, 1); } catch (e) { this.log.warn(`inline job ${name} failed: ${(e as Error).message}`); }
      return;
    }
    await this.getQueue().add(name, data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      delay: opts.delayMs,
      jobId: opts.jobId,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async onModuleDestroy() {
    await this.queue?.close();
    this.conn?.disconnect();
  }
}
