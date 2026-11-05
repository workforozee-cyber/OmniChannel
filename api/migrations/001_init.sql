-- 001_init.sql — core schema for the OmniChannel platform
-- Every tenant-owned table carries org_id so the system is multi-tenant from day one.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'GBP',
  -- settings: { safetyBuffer: { mode: 'units'|'percent', value: number }, lowStockThreshold: number }
  settings    jsonb NOT NULL DEFAULT '{"safetyBuffer":{"mode":"units","value":0},"lowStockThreshold":5}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner','admin','manager','viewer')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  address     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_default_warehouse ON warehouses(org_id) WHERE is_default;

-- ───────────── Catalog ─────────────
CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type          text NOT NULL DEFAULT 'simple' CHECK (type IN ('simple','variable','bundle')),
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  brand         text,
  manufacturer  text,
  category      text,
  tags          text[] NOT NULL DEFAULT '{}',
  images        jsonb NOT NULL DEFAULT '[]',   -- [{url, alt}]
  videos        jsonb NOT NULL DEFAULT '[]',
  attributes    jsonb NOT NULL DEFAULT '{}',   -- generic + per-marketplace: { ebay: {...}, amazon: {...} }
  shipping      jsonb NOT NULL DEFAULT '{}',   -- { profile, handlingDays, ... }
  supplier      jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_org ON products(org_id);

CREATE TABLE variants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id           uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                  text NOT NULL,
  barcode              text,               -- UPC / EAN / GTIN
  options              jsonb NOT NULL DEFAULT '{}',  -- { color, size, material }
  cost_price           numeric(12,2),
  price                numeric(12,2) NOT NULL DEFAULT 0,   -- master selling price
  min_price            numeric(12,2),
  max_price            numeric(12,2),
  weight_grams         integer,
  dimensions           jsonb,              -- { lengthCm, widthCm, heightCm }
  low_stock_threshold  integer,
  safety_buffer        integer,            -- per-SKU override of org buffer (units)
  position             integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, sku)
);
CREATE INDEX variants_barcode ON variants(org_id, barcode);

-- Bundles/kits: a bundle variant consumes component variants. Bundle stock is derived.
CREATE TABLE bundle_components (
  bundle_variant_id     uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  component_variant_id  uuid NOT NULL REFERENCES variants(id) ON DELETE RESTRICT,
  quantity              integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (bundle_variant_id, component_variant_id),
  CHECK (bundle_variant_id <> component_variant_id)
);

-- ───────────── Inventory ─────────────
-- on_hand = physical units; reserved = units held by open orders. Available = on_hand - reserved.
CREATE TABLE inventory_levels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  on_hand       integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved      integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, warehouse_id),
  CHECK (reserved <= on_hand)
);

CREATE TABLE inventory_movements (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  warehouse_id    uuid NOT NULL REFERENCES warehouses(id),
  delta_on_hand   integer NOT NULL DEFAULT 0,
  delta_reserved  integer NOT NULL DEFAULT 0,
  on_hand_after   integer NOT NULL,
  reserved_after  integer NOT NULL,
  reason          text NOT NULL,   -- order_reserved | order_fulfilled | order_cancelled | manual_adjustment | import | initial
  ref_type        text,
  ref_id          text,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX movements_variant ON inventory_movements(variant_id, created_at DESC);

-- ───────────── Marketplaces ─────────────
CREATE TABLE marketplace_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  marketplace       text NOT NULL CHECK (marketplace IN ('ebay','amazon','etsy','walmart','shopify')),
  account_name      text NOT NULL,
  external_account_id text,
  mode              text NOT NULL CHECK (mode IN ('live','mock')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','expired','error','disconnected')),
  credentials_enc   text,          -- AES-256-GCM ciphertext; never returned by the API
  token_expires_at  timestamptz,
  settings          jsonb NOT NULL DEFAULT '{}',  -- per-channel config: policy IDs, location IDs, price sync, etc.
  last_sync_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connections_org ON marketplace_connections(org_id);

CREATE TABLE oauth_states (
  state          text PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id  uuid REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  marketplace    text NOT NULL,
  code_verifier  text,
  context        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pricing_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('percent','fixed')),
  value          numeric(12,4) NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id)
);

-- ───────────── Listings ─────────────
CREATE TABLE listings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id                uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  connection_id             uuid NOT NULL REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  status                    text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','validation_required','queued','published','paused','ended','failed')),
  external_id               text,
  external_url              text,
  -- Channel-specific overrides. A key present here wins over the master product field.
  overrides                 jsonb NOT NULL DEFAULT '{}',
  price_override            numeric(12,2),
  sync_price_with_master    boolean NOT NULL DEFAULT true,
  missing_fields            jsonb NOT NULL DEFAULT '[]',
  last_error                text,
  published_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, connection_id)
);
CREATE INDEX listings_conn ON listings(connection_id);

CREATE TABLE listing_variants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  variant_id        uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  external_ref      text,           -- marketplace SKU / variant id / inventory item id
  last_pushed_qty   integer,
  last_pushed_price numeric(12,2),
  last_pushed_at    timestamptz,
  UNIQUE (listing_id, variant_id)
);
CREATE INDEX listing_variants_variant ON listing_variants(variant_id);

CREATE TABLE price_history (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  variant_id  uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  listing_id  uuid REFERENCES listings(id) ON DELETE CASCADE,
  old_price   numeric(12,2),
  new_price   numeric(12,2) NOT NULL,
  reason      text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Orders ─────────────
CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL REFERENCES marketplace_connections(id) ON DELETE RESTRICT,
  marketplace         text NOT NULL,
  external_order_id   text NOT NULL,
  customer_name       text,
  customer_email      text,
  ship_address        jsonb,
  order_date          timestamptz NOT NULL,
  internal_status     text NOT NULL DEFAULT 'new' CHECK (internal_status IN ('new','processing','on_hold','shipped','completed','cancelled')),
  marketplace_status  text,
  payment_status      text NOT NULL DEFAULT 'paid',
  fulfillment_status  text NOT NULL DEFAULT 'unfulfilled' CHECK (fulfillment_status IN ('unfulfilled','partial','fulfilled','cancelled')),
  currency            char(3) NOT NULL DEFAULT 'GBP',
  subtotal            numeric(12,2) NOT NULL DEFAULT 0,
  shipping_cost       numeric(12,2) NOT NULL DEFAULT 0,
  tax                 numeric(12,2) NOT NULL DEFAULT 0,
  fees                numeric(12,2),           -- marketplace fees, when the API reports them
  refunds             numeric(12,2) NOT NULL DEFAULT 0,
  total               numeric(12,2) NOT NULL DEFAULT 0,
  shipping_method     text,
  carrier             text,
  tracking_number     text,
  label_url           text,
  stock_conflict      boolean NOT NULL DEFAULT false,  -- true when an order arrived for stock we did not have
  raw                 jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Order deduplication: the same marketplace order can arrive via webhook AND polling.
  UNIQUE (connection_id, external_order_id)
);
CREATE INDEX orders_org_date ON orders(org_id, order_date DESC);

CREATE TABLE order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id     uuid REFERENCES variants(id) ON DELETE SET NULL,
  external_line_id text,
  sku            text,
  title          text NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  unit_price     numeric(12,2) NOT NULL DEFAULT 0,
  stock_state    text NOT NULL DEFAULT 'unmapped' CHECK (stock_state IN ('unmapped','reserved','short','fulfilled','released'))
);
CREATE INDEX order_items_order ON order_items(order_id);

CREATE TABLE order_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Webhooks, sync, notifications, audit ─────────────
CREATE TABLE webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      uuid REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  marketplace        text NOT NULL,
  external_event_id  text NOT NULL,
  topic              text,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  error              text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  UNIQUE (marketplace, external_event_id)
);

CREATE TABLE sync_logs (
  id                 bigserial PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id      uuid REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  listing_id         uuid REFERENCES listings(id) ON DELETE CASCADE,
  variant_id         uuid REFERENCES variants(id) ON DELETE CASCADE,
  kind               text NOT NULL,      -- inventory | price | publish | update | status | orders_poll | tracking
  status             text NOT NULL CHECK (status IN ('success','failed','skipped')),
  detail             jsonb NOT NULL DEFAULT '{}',
  error              text,
  attempt            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_logs_org ON sync_logs(org_id, created_at DESC);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type        text NOT NULL,   -- new_order | low_stock | out_of_stock | listing_failed | connection_expired | sync_failed | api_error | fulfillment_issue | stock_conflict
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error')),
  title       text NOT NULL,
  body        text,
  ref_type    text,
  ref_id      text,
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org ON notifications(org_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe ON notifications(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND read_at IS NULL;

CREATE TABLE activity_log (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  message      text NOT NULL,
  level        text NOT NULL DEFAULT 'info' CHECK (level IN ('info','success','warning','error')),
  meta         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_org ON activity_log(org_id, created_at DESC);

-- Imported marketplace listings awaiting matching to the central catalog.
CREATE TABLE import_staging (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  external_id         text NOT NULL,
  external_variant_ref text,
  sku                 text,
  barcode             text,
  title               text NOT NULL,
  price               numeric(12,2),
  quantity            integer,
  image_url           text,
  raw                 jsonb,
  suggested_variant_id uuid REFERENCES variants(id) ON DELETE SET NULL,
  match_method        text,       -- sku | barcode | null (titles are never auto-matched)
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','created','ignored')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id, external_variant_ref)
);

-- Exactly which stock (variant × warehouse) an order line holds. Bundles allocate their components.
-- Lets cancellation/fulfilment release or consume precisely what was reserved, across warehouses.
CREATE TABLE order_item_allocations (
  id             bigserial PRIMARY KEY,
  order_item_id  uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  variant_id     uuid NOT NULL REFERENCES variants(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  quantity       integer NOT NULL CHECK (quantity > 0),
  state          text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','fulfilled','released'))
);
CREATE INDEX allocations_item ON order_item_allocations(order_item_id);
