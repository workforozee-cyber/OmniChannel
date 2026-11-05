# Development report — MVP build (Phases 1–8, first pass)

This pass delivers a working MVP across all eight phases, built depth-first on what everything else depends on: the catalog, the inventory engine, the adapter framework, and two live adapters. Etsy, Amazon and Walmart are deliberately **framework-only**, not superficial "integrations".

## Features completed

| Area | Status |
|---|---|
| **1. Foundation** | Monorepo, Postgres schema (23 tables), migrations, JWT auth, 4-role RBAC, multi-tenant isolation, activity log, notifications |
| **2. Marketplace connections** | Connections page; OAuth flows (Shopify, eBay, Etsy PKCE, Amazon LWA), encrypted credential storage, status/expiry/reconnect/disconnect, multiple accounts per marketplace, mock mode for all five |
| **3. Listings** | Product form with all requested fields; one-click publish to selected channels with independent per-channel validation and missing-field reporting; per-channel overrides that survive master edits; re-sync from master; pause/activate/end; duplicate; retry; bulk publish |
| **4. Inventory** | Central stock pool; atomic reservation; order de-duplication; safety buffer (org units/%, per-SKU override); bundles/kits; multi-warehouse model; manual adjustments with floor at reserved; full movement history; low/out-of-stock alerts; sync log; failed-sync notifications; hourly reconciliation |
| **5. Orders** | Unified order list with every requested column and filter; order detail with origin, items, money breakdown, customer, history, internal notes and internal status; cancel/fulfil stock transitions; stock-conflict flagging |
| **6. Shipping** | Per-order provider/service/tracking/label status; tracking upload to marketplace (Shopify/eBay live, mock); deep link to the marketplace's own order page; capability table showing where labels can and can't be bought via API |
| **7. Pricing & analytics** | Master price, channel rules (± % / ± amount), fixed channel prices, min/max protection, bulk changes with preview, price history. Dashboard with all requested KPIs; analytics with date/marketplace filters, daily/monthly series, revenue/orders by marketplace, best sellers, inventory value, and gross/refunds/fees/COGS/estimated profit kept separate (profit flagged as partial when fee or cost data is missing) |
| **8. Bulk, testing, deployment** | CSV + XLSX import with preview, validation report, per-row result report; CSV/XLSX export; import from marketplace with SKU/barcode match suggestions and user confirmation (never by title); 25 integration tests; Dockerfiles, docker-compose, CI workflow, backup script |

## Files created

- `api/` — NestJS backend (`src/**`, `migrations/001_init.sql`, `scripts/migrate.ts`, `scripts/seed.ts`, `test/**`, `Dockerfile`, `.env.example`)
- `web/` — Next.js dashboard: 12 sections plus product, order, import and bulk-publish pages (`src/app/**`, `src/components/**`, `src/lib/api.ts`, `Dockerfile`)
- `docker-compose.yml`, `.github/workflows/ci.yml`, `ops/backup.sh`, `README.md`, `docs/*`

## Database

Tables: organizations, users, warehouses, products, variants, bundle_components, inventory_levels, inventory_movements, marketplace_connections, oauth_states, pricing_rules, listings, listing_variants, price_history, orders, order_items, order_item_allocations, order_notes, webhook_events, sync_logs, notifications, activity_log, import_staging.

Key constraints: `UNIQUE(org_id, sku)`, `UNIQUE(connection_id, external_order_id)`, `UNIQUE(marketplace, external_event_id)`, `CHECK(on_hand >= 0)`, `CHECK(reserved <= on_hand)`.

## Integrations

| | Code | Tested against real API? |
|---|---|---|
| Shopify | Live adapter, GraphQL operations checked against the 2026-04 schema | **No** — needs a dev store + app credentials |
| eBay | Live adapter | **No** — needs sandbox keys |
| Etsy / Amazon / Walmart | Framework (auth + validation + webhook verification) | n/a — API calls intentionally unimplemented |
| Mock (all five) | Complete | Yes |

## Tests performed

- **Automated: 25/25 passing** against real PostgreSQL. They cover concurrency (10-way race for the last unit, 100 parallel orders), your spec's Scenario A/B, de-duplication, cancel/fulfil, buffer, bundles, failure isolation, publishing validation, overrides, pricing, encryption, credential non-exposure, RBAC, tenant isolation, webhook signatures and replay, bulk import/export, and analytics.
- **End-to-end:** API + separate BullMQ worker + Redis + web app running together. A mock Amazon order went through the real queue and updated all five channels, with the activity log matching the spec's example.
- **Browser (headless Chrome):** signed in, created a product through the form, published to all five channels, simulated an eBay sale of 3 (every channel then showed 97), added tracking via the confirmation dialog (order fulfilled). All 12 sections render at desktop and 390 px mobile with no page errors.
- **Production build:** `next build` (20 routes) and `tsc` both clean.
- **Not run here:** `docker compose up` (no Docker daemon in the build environment). The Dockerfiles and compose file are written but should be run once on your machine.

## Remaining issues / known limitations

1. Live Shopify and eBay adapters have not yet been run against real accounts.
2. Etsy, Amazon and Walmart need their listing/stock/order API calls written (next phase).
3. Images are referenced by URL; there's no file upload/storage yet (S3-compatible storage planned).
4. eBay import links by SKU; the offer ID for stock pushes is resolved on first publish/update rather than at import.
5. Editing bundle components after creation isn't wired into the update endpoint yet.
6. Analytics sums in each order's currency; no FX conversion for multi-currency sellers.
7. No password reset / 2FA / refresh-token rotation yet; sessions are 12-hour JWTs in localStorage (moving to httpOnly cookies is recommended before public launch).
8. Rate limiting of our own API (per user/IP) isn't added yet.
9. The oversell window before a marketplace applies our zero can't be eliminated, only reduced (buffer + fast push); such cases are flagged, never silently lost.

## Credentials and approvals needed from you

| Marketplace | What to get | Lead time |
|---|---|---|
| Shopify | Partner account → app → Client ID/secret; a development store for testing | Same day (custom app); public listing needs review + Protected Customer Data approval |
| eBay | Developers Program keyset (sandbox + production), RuName, notification verification token; seller account with business policies | Days |
| Etsy | App keystring + shared secret; webhook secret; request commercial access if managing others' shops | Days–weeks |
| Amazon | Professional seller account; SP-API developer registration with roles (incl. restricted Direct-to-Consumer Shipping for buyer addresses) | Weeks |
| Walmart | Approved Marketplace seller account → API keys; Solution Provider approval only if serving other sellers | Weeks |

Also needed for deployment: a host for API + worker + web, managed Postgres (with PITR) and Redis, a public HTTPS domain (OAuth redirects and webhooks require it), and a secret manager for `JWT_SECRET` / `ENCRYPTION_KEY`.

## Next development phase

1. **Verify live adapters:** run Shopify against a dev store and eBay against sandbox; fix anything the real APIs reject; add recorded-response contract tests.
2. **Etsy live adapter** (fewest approval hurdles of the remaining three).
3. **Walmart** then **Amazon** (SQS consumer, product-type schema fetching and caching).
4. Image upload/storage, password reset + 2FA, httpOnly session cookies, API rate limiting.
5. Per-channel warehouse assignment; label purchase where APIs allow (Amazon MFN, Ship with Walmart).
