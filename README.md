# OmniChannel — multi-channel e-commerce management

Create a product once, publish it to eBay, Amazon, Etsy, Walmart and Shopify, keep one central stock pool in sync across all of them, and manage every order from one dashboard.

| | |
|---|---|
| **Frontend** | Next.js 14 (App Router) · React · TypeScript · Tailwind · Recharts |
| **Backend** | NestJS 10 · TypeScript · Zod validation · JWT auth + RBAC |
| **Database** | PostgreSQL 16 (SQL migrations, row-level locking for stock) |
| **Jobs** | Redis + BullMQ (separate worker process; retries with backoff; scheduled polling & reconciliation) |
| **Infra** | Docker / docker-compose · GitHub Actions CI · env-based config |

## What's live vs. mock

| Marketplace | Status | Notes |
|---|---|---|
| **Shopify** | **Live adapter** (Admin GraphQL API 2026-04) | OAuth, publish, stock, prices, status, orders, webhooks, tracking, import. Operations checked against Shopify's current schema. |
| **eBay** | **Live adapter** (Sell Inventory + Fulfillment APIs) | OAuth + refresh, publish (incl. variation groups), stock/price bulk updates, orders by polling, tracking, signed notifications, import. |
| Etsy | Framework | OAuth (PKCE), webhook signature verification and listing rules done; listing/stock/order calls not yet written. |
| Amazon | Framework | LWA authorisation flow and listing rules done; SP-API calls need developer registration first. |
| Walmart | Framework | Encrypted credential storage and listing rules done; API calls need seller/Solution Provider approval. |

Every marketplace can also be connected in **mock mode**, clearly badged **MOCK** everywhere. It uses that marketplace's real validation rules but never contacts it, so the full workflow can be tried before credentials exist. Framework adapters **refuse** live calls with an explicit error instead of pretending to work.

> The live Shopify and eBay adapters are written against the official docs but have **not yet been run against a real store/account** (no credentials were available). First step with credentials: run them against a Shopify development store and the eBay sandbox. See `docs/MARKETPLACES.md`.

## Put it online (recommended)

One click on Render.com gives you a link that opens in Chrome; no terminal needed. Follow **[docs/DEPLOY.md](docs/DEPLOY.md)**. `render.yaml` + the root `Dockerfile` run the website, API and scheduled jobs as a single service.

## Quick start (local, no Docker)

Requirements: Node 20+, PostgreSQL 14+, Redis 6+.

```bash
npm run setup                          # install api + web deps
cp api/.env.example api/.env           # then set DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
cp web/.env.example web/.env.local
createdb omnichannel
npm run migrate
npm run seed                           # optional demo data (all MOCK)

npm run dev:api      # http://localhost:4000
npm run dev:worker   # background jobs (stock sync, publishing, polling)
npm run dev:web      # http://localhost:3000
```

Demo login (after `npm run seed`): **demo@omnichannel.dev / demo-password-123**

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

## Quick start (Docker)

```bash
cp api/.env.example api/.env   # fill secrets; DATABASE_URL/REDIS_URL are set by compose
docker compose up --build      # postgres, redis, migrate, api, worker, web
docker compose run --rm api node dist/scripts/seed.js   # optional demo data
```

## Tests

```bash
createdb omnichannel_test
npm test        # 25 integration tests against real Postgres
```

These cover:
- **Oversell protection:** 10 simultaneous orders for the last unit across 5 marketplaces, exactly 1 succeeds. 100 concurrent orders against 100 units land at exactly 0.
- **Your spec scenarios:** order de-duplication, plus Scenario A and B (Amazon −1 then eBay −3, every channel shows 96).
- **Stock rules:** safety buffer, bundles, cancellation and fulfilment.
- **Failure handling:** a failing channel is isolated from the others.
- **Listings:** per-channel validation, overrides that survive master edits, pricing rules, min/max protection.
- **Security:** encrypted credentials never exposed, RBAC, tenant isolation, and webhook signatures (Shopify HMAC, Etsy Standard Webhooks, signed mock) with replay de-duplication.
- **Bulk and analytics:** CSV/XLSX import preview, apply and export; analytics money separation.

## Project layout

```
api/
  migrations/            SQL schema (forward-only, transactional)
  src/
    marketplaces/        adapter contract, registry, validation rules, adapters/ (shopify, ebay, framework, mock)
    inventory/           stock engine: reservations, movements, buffer, bundles, alerts
    orders/              ingestion (dedupe, transitions), polling, tracking
    listings/            effective listing (master + overrides), publish pipeline, status
    pricing/             channel rules, min/max, bulk changes, history
    catalog/             products, variants, bundles, import + matching
    bulk/                CSV/XLSX import preview/apply, export
    analytics/           dashboard + sales reporting
    jobs/                BullMQ façade + sync processor (handlers)
    webhooks/            signed inbound webhooks
    worker.ts            background worker entry point
  test/                  integration tests
web/src/app/             12 dashboard sections + product/order detail pages
docs/                    ARCHITECTURE.md · MARKETPLACES.md · PHASE_REPORT.md
ops/backup.sh            nightly pg_dump with retention
```

## Adding another marketplace

1. Implement `MarketplaceAdapter` (`api/src/marketplaces/types.ts`) in `adapters/<name>.adapter.ts`.
2. Add its validation rules in `validation.ts` and register it in `registry.ts`.
3. Add the code to the `marketplace_connections.marketplace` CHECK in a new migration.

Catalog, inventory, orders, pricing and the UI pick it up automatically.
