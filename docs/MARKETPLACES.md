# Marketplace integration notes

Researched against official developer documentation in November 2026. Platforms change their APIs often, so re-check before going live.

---

## Shopify — live adapter

- **API:** Admin GraphQL, pinned to **2026-04** (`SHOPIFY_API_VERSION`). Shopify marked REST Admin as legacy in Oct 2024; new public apps must be GraphQL-only since April 2025.
- **Verified against the live schema:** `productSet` (create; updates use the `identifier` argument), `inventorySetQuantities` (2026-04 requires `changeFromQuantity` on each entry; we pass `null` deliberately because this system is the source of truth for stock), variant `barcodes`, and `webhookSubscriptionCreate` (`uri`).
- **Auth:** OAuth authorisation-code. Callback HMAC is verified before code exchange. Scopes are set in `SHOPIFY_SCOPES`.
- **Orders:** webhooks `orders/create`, `orders/updated`, `orders/cancelled` (HMAC-SHA256 of the raw body), plus polling every 10 min as a backup.
- **Fulfilment:** `fulfillmentCreate` with tracking. Labels: Shopify Shipping has no public label-purchase API, so we link to the order in Shopify Admin.
- **Approvals:** create an app in the Partner Dashboard, or a custom app per store. **Public apps that read customer names/addresses need Protected Customer Data approval.**
- **You provide:** `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`; set the app redirect URL to `{PUBLIC_API_URL}/api/marketplaces/oauth/shopify/callback`.

## eBay — live adapter

- **APIs:** Sell Inventory (inventory item → offer → publish; inventory item groups for variations), Sell Fulfillment (orders, shipping fulfilment), Sell Account (policies), Notification API.
- **Auth:** OAuth authorisation-code with **RuName**; access token about 2 h, refresh token about 18 months; refreshed automatically before expiry; the connection is marked "expired" and you're notified if refresh fails.
- **Orders:** the REST Notification API doesn't expose a general "new seller order" topic, so orders are detected by **polling `getOrders` by `lastmodifieddate`** (10-min default, overlapping windows, de-duplicated). Notification pushes are verified with `X-EBAY-SIGNATURE` (ECDSA, public key fetched by `kid`). The endpoint-validation challenge is implemented.
- **Stock/price:** `bulk_update_price_quantity`, at most 25 SKUs per call (batched).
- **Requirements per seller:** business policies opted in (payment / return / fulfilment policy IDs) and a merchant location key. These are set per connection in Marketplaces → Settings and validated before publishing.
- **Pause:** eBay has no pause, so we set quantity to 0 (and restore on reactivate). End = withdraw offer.
- **Labels:** eBay Labels are bought in Seller Hub; the Logistics API is limited-release, so we link out.
- **Approvals:** Developers Program keyset. Production keysets must handle **Marketplace Account Deletion** notifications. Some notification topics are restricted to approved partners.
- **You provide:** `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`, `EBAY_NOTIFICATION_VERIFICATION_TOKEN`. Start with `EBAY_ENV=sandbox`.

## Etsy — framework

- **Done:** OAuth 2 + **PKCE** (required by Etsy), token exchange, **Standard-Webhooks signature verification** (`webhook-id`/`webhook-timestamp`/`webhook-signature`, HMAC-SHA256, 5-minute replay window; tested), listing validation (title ≤ 140, taxonomy_id, who_made, when_made, is_supply, shipping profile, min price 0.20, image to activate).
- **To build:** `createDraftListing` + image upload (multipart, so URLs must be downloaded first), `updateListingInventory` (needs the full products array: read, modify quantities, write back), receipts polling, `createReceiptShipment` for tracking.
- **Webhooks:** `order.paid`, `order.canceled`, `order.shipped`, `order.delivered`, plus listing/inventory events. Payloads carry only IDs + `resource_url`, so each needs a follow-up fetch.
- **Approvals:** apps start with personal access; **commercial access (other sellers' shops) requires Etsy review.** Every call needs both the bearer token and the `x-api-key` header.
- **You provide:** `ETSY_KEYSTRING`, `ETSY_SHARED_SECRET`, `ETSY_WEBHOOK_SECRET`.

## Amazon SP-API — framework

- **Done:** Login-with-Amazon website authorisation URL and token exchange, listing validation baseline (product type, brand, GTIN or exemption, condition, bullet points, main image).
- **To build:** request signing / LWA access tokens, `putListingsItem` with **product-type JSON Schemas** fetched from the Product Type Definitions API (requirements are per product type, so the static rules here are only a baseline), `LISTINGS_ITEM_ISSUES_CHANGE` handling, Orders API polling, `ORDER_CHANGE` notifications.
- **Important difference:** notifications are delivered to **Amazon SQS or EventBridge**, not HTTP webhooks, so this needs an SQS consumer in the worker.
- **FBA:** stock in Amazon's warehouses is controlled by Amazon; only merchant-fulfilled (MFN) quantity can be pushed.
- **Approvals (the long pole):** SP-API developer registration in the Solution Provider Portal with role approval. **Buyer PII (name/address) needs the restricted Direct-to-Consumer Shipping role and Restricted Data Tokens.** Some brands and categories need seller ungating.
- **You provide:** `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_SP_APP_ID`, region.

## Walmart Marketplace — framework

- **Done:** encrypted storage of a seller's client ID/secret, listing validation (product type, brand, GTIN/UPC per item, short description, main image, shipping weight).
- **To build:** token API (client credentials), item bulk feeds (MP_ITEM spec; asynchronous status), inventory updates by SKU/ship node, Orders API (acknowledge, ship), Notifications API (`PO_CREATED`, inventory OOS).
- **Approvals:** Walmart Marketplace seller approval (US/CA/MX/CL only). Managing *other* sellers requires **approved Solution Provider status and delegated OAuth.**
- **You provide:** client ID/secret from Seller Center (pasted into the app, encrypted at rest).

---

### Rate limits and retries (all adapters)

`marketplaces/http.ts` retries 429 and 5xx up to 3 times with exponential backoff + jitter, honouring `Retry-After`. Shopify GraphQL `THROTTLED` errors are treated as 429. Failed jobs are retried by BullMQ (5 attempts, exponential). Inventory pushes are absolute, so retries are safe.
