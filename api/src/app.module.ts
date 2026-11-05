import { Controller, Get, Module, Query, Res, Param } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Response } from 'express';
import { ActivityService } from './activity/activity.service';
import { AnalyticsService } from './analytics/analytics.service';
import { AuthController } from './auth/auth.controller';
import { BulkService } from './bulk/bulk.service';
import { CatalogService } from './catalog/catalog.service';
import { config } from './common/config';
import { pool } from './common/db';
import { AuthGuard, Public } from './common/http';
import {
  AnalyticsController, BulkController, InventoryController, ListingsController, MarketplacesController,
  OrdersController, PricingController, ProductsController, SystemController,
} from './controllers';
import { InventoryService } from './inventory/inventory.service';
import { JobsService } from './jobs/jobs.service';
import { SyncProcessor } from './jobs/sync.processor';
import { ListingsService } from './listings/listings.service';
import { ConnectionsService } from './marketplaces/connections.service';
import { MarketplaceCode } from './marketplaces/types';
import { OrdersService } from './orders/orders.service';
import { PricingService } from './pricing/pricing.service';
import { WebhooksController } from './webhooks/webhooks.controller';

@Controller()
class HealthController {
  constructor(private conns: ConnectionsService) {}
  @Public() @Get('health')
  async health() { await pool.query('SELECT 1'); return { ok: true, jobsInline: config.jobsInline }; }

  /** OAuth redirect target (public): exchange code, then send the user back to the dashboard. */
  @Public() @Get('marketplaces/oauth/:marketplace/callback')
  async callback(@Param('marketplace') m: MarketplaceCode, @Query() qs: Record<string, string>, @Res() res: Response) {
    try {
      await this.conns.completeOAuth(m, qs);
      res.redirect(`${config.webOrigin}/marketplaces?connected=${m}`);
    } catch (e: any) {
      res.redirect(`${config.webOrigin}/marketplaces?error=${encodeURIComponent(e.message)}`);
    }
  }
}

export const PROVIDERS = [
  ActivityService, JobsService, InventoryService, PricingService, ConnectionsService, ListingsService,
  OrdersService, CatalogService, AnalyticsService, BulkService, SyncProcessor,
];

@Module({
  controllers: [
    HealthController, AuthController, ProductsController, ListingsController, InventoryController, OrdersController,
    MarketplacesController, PricingController, AnalyticsController, BulkController, SystemController, WebhooksController,
  ],
  providers: [...PROVIDERS, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}

/** Worker process: no HTTP controllers, just job handlers. */
@Module({ providers: PROVIDERS })
export class WorkerModule {}
