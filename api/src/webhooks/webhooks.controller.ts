import { Controller, Get, HttpCode, Logger, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { one } from '../common/db';
import { Public } from '../common/http';
import { JobsService } from '../jobs/jobs.service';
import { EbayAdapter } from '../marketplaces/adapters/ebay.adapter';
import { ConnectionsService } from '../marketplaces/connections.service';
import { adapterFor } from '../marketplaces/registry';
import { Connection } from '../marketplaces/types';
import { createHash } from 'crypto';

/**
 * Inbound marketplace webhooks: /api/webhooks/:marketplace/:connectionId
 *  1. Verify signature against the RAW body (rejects with 401 otherwise)
 *  2. De-duplicate on the marketplace's event id (UNIQUE(marketplace, external_event_id))
 *  3. Persist, ack 200 fast, process asynchronously (marketplaces retry on slow/failed responses)
 */
@Controller('webhooks')
export class WebhooksController {
  private log = new Logger('Webhooks');
  constructor(private conns: ConnectionsService, private jobs: JobsService) {}

  /** eBay endpoint validation handshake. */
  @Public()
  @Get('ebay/:connectionId')
  ebayChallenge(@Query('challenge_code') code: string, @Req() req: Request, @Res() res: Response) {
    const endpoint = `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`;
    res.json({ challengeResponse: EbayAdapter.challengeResponse(code, endpoint) });
  }

  @Public()
  @Post(':marketplace/:connectionId')
  @HttpCode(200)
  async receive(@Param('marketplace') mp: string, @Param('connectionId') cid: string, @Req() req: Request & { rawBody?: Buffer }) {
    let conn: Connection;
    try { conn = await this.conns.load(cid); } catch { throw new UnauthorizedException(); }
    if (conn.marketplace !== mp) throw new UnauthorizedException();
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const adapter = adapterFor(conn);
    const ok = await adapter.verifyWebhook(conn, req.headers as any, raw, req.originalUrl).catch(() => false);
    if (!ok) {
      this.log.warn(`Rejected unsigned/invalid webhook for ${mp}/${cid}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }
    const headers = pickHeaders(req.headers as any);
    const eventId = headerEventId(mp, headers) || createHash('sha256').update(raw).digest('hex');
    const ev = await one(
      `INSERT INTO webhook_events(connection_id,marketplace,external_event_id,topic,payload) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (marketplace, external_event_id) DO NOTHING RETURNING id`,
      [conn.id, conn.mode === 'mock' ? `${mp}-mock` : mp, eventId, headers['x-shopify-topic'] ?? null, { headers, body: req.body }]);
    if (!ev) return { ok: true, duplicate: true };
    await this.jobs.enqueue('webhook', { eventId: ev.id });
    return { ok: true };
  }
}

function pickHeaders(h: Record<string, any>) {
  const keep = /^(x-shopify-|x-ebay-|webhook-|x-mock-|x-walmart-|content-type)/;
  return Object.fromEntries(Object.entries(h).filter(([k]) => keep.test(k)));
}
function headerEventId(mp: string, h: Record<string, any>): string | null {
  return h['x-shopify-event-id'] ?? h['x-shopify-webhook-id'] ?? h['webhook-id'] ?? h['x-mock-event-id'] ?? null;
}
