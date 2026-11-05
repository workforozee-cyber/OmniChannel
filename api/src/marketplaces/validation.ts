import { Connection, EffectiveListing, MarketplaceCode, MissingField } from './types';

/**
 * Per-marketplace listing requirements. Used by both the live adapters and mock mode, so mock-mode
 * publishing reports the same "Validation Required" results you'd get for real.
 *
 * Sources (verified Nov 2026): eBay Sell Inventory API, Amazon SP-API Product Type Definitions,
 * Etsy Open API v3 createDraftListing, Walmart MP_ITEM spec, Shopify Admin GraphQL productSet.
 * Amazon's real requirements are product-type-specific JSON Schemas fetched at runtime
 * (getDefinitionsProductType); the static list below is the common minimum.
 */
type Rule = (l: EffectiveListing, conn: Connection) => MissingField | MissingField[] | null;

const need = (cond: boolean, field: string, label: string, message: string): MissingField | null =>
  cond ? null : { field, label, message };

const anyBarcode = (l: EffectiveListing) => l.variants.every((v) => !!v.barcode) || !!l.attributes.gtinExempt;
const hasPrice = (l: EffectiveListing) => l.variants.length > 0 && l.variants.every((v) => v.price > 0);

const RULES: Record<MarketplaceCode, Rule[]> = {
  ebay: [
    (l) => need(!!l.title && l.title.length <= 80, 'title', 'Title', 'eBay titles are required and limited to 80 characters'),
    (l) => need(!!l.description, 'description', 'Description', 'Description is required'),
    (l) => need(!!l.attributes.categoryId, 'attributes.ebay.categoryId', 'eBay category ID', 'Select an eBay leaf category'),
    (l) => need(!!l.attributes.condition, 'attributes.ebay.condition', 'Condition', 'Condition is required (e.g. NEW)'),
    (l) => need(l.images.length > 0, 'images', 'Images', 'At least one image is required'),
    (l) => need(hasPrice(l), 'price', 'Price', 'Every variant needs a price above 0'),
    (l) => need(l.variants.every((v) => v.sku.length <= 50), 'sku', 'SKU', 'eBay SKUs are limited to 50 characters'),
    (_l, c) => need(!!(c.settings.fulfillmentPolicyId && c.settings.paymentPolicyId && c.settings.returnPolicyId),
      'connection.policies', 'Business policies', 'Set fulfillment, payment and return policy IDs on the eBay connection'),
    (_l, c) => need(!!c.settings.merchantLocationKey, 'connection.merchantLocationKey', 'Inventory location', 'Set an eBay merchant location key on the connection'),
  ],
  amazon: [
    (l) => need(!!l.attributes.productType, 'attributes.amazon.productType', 'Amazon product type', 'Choose an Amazon product type (e.g. TOY_FIGURE)'),
    (l) => need(!!l.title && l.title.length <= 200, 'title', 'Title', 'Title is required (max 200 characters)'),
    (l) => need(!!l.brand, 'brand', 'Brand', 'Brand is required; brand approval may also be needed for restricted brands'),
    (l) => need(anyBarcode(l), 'barcode', 'Product identifier', 'Each variant needs a UPC/EAN/GTIN, or an approved GTIN exemption'),
    (l) => need(!!l.attributes.condition, 'attributes.amazon.condition', 'Condition', 'Condition is required (e.g. new_new)'),
    (l) => need(Array.isArray(l.attributes.bulletPoints) && l.attributes.bulletPoints.length > 0, 'attributes.amazon.bulletPoints', 'Bullet points', 'Add at least one bullet point'),
    (l) => need(l.images.length > 0, 'images', 'Main image', 'A main image is required'),
    (l) => need(hasPrice(l), 'price', 'Price', 'Every variant needs a price above 0'),
  ],
  etsy: [
    (l) => need(!!l.title && l.title.length <= 140, 'title', 'Title', 'Etsy titles are required and limited to 140 characters'),
    (l) => need(!!l.description, 'description', 'Description', 'Description is required'),
    (l) => need(!!l.attributes.taxonomyId, 'attributes.etsy.taxonomyId', 'Etsy taxonomy ID', 'Choose an Etsy category (taxonomy_id)'),
    (l) => need(['i_did', 'someone_else', 'collective'].includes(l.attributes.whoMade), 'attributes.etsy.whoMade', 'Who made it', 'Required: i_did, someone_else or collective'),
    (l) => need(!!l.attributes.whenMade, 'attributes.etsy.whenMade', 'When was it made', 'Required, e.g. made_to_order or 2020_2026'),
    (l) => need(typeof l.attributes.isSupply === 'boolean', 'attributes.etsy.isSupply', 'Is it a supply', 'Say whether this is a craft supply'),
    (l, c) => need(!!(l.attributes.shippingProfileId || c.settings.shippingProfileId), 'attributes.etsy.shippingProfileId', 'Shipping profile', 'Physical listings need an Etsy shipping profile'),
    (l) => need(l.variants.every((v) => v.price >= 0.2), 'price', 'Price', 'Etsy minimum price is 0.20'),
    (l) => need(l.images.length > 0, 'images', 'Images', 'At least one image is required to activate an Etsy listing'),
  ],
  walmart: [
    (l) => need(!!l.attributes.productType, 'attributes.walmart.productType', 'Walmart product type', 'Choose a Walmart product type from the item spec'),
    (l) => need(!!l.title && l.title.length <= 150, 'title', 'Product name', 'Product name is required (max 150 characters)'),
    (l) => need(!!l.brand, 'brand', 'Brand', 'Brand is required'),
    (l) => need(l.variants.every((v) => !!v.barcode), 'barcode', 'Product ID (GTIN/UPC)', 'Walmart requires a GTIN, UPC or EAN for every item'),
    (l) => need(!!(l.attributes.shortDescription || l.description), 'description', 'Short description', 'A short description is required'),
    (l) => need(l.images.length > 0, 'images', 'Main image', 'Main image URL is required'),
    (l) => need(l.variants.every((v) => !!v.weightGrams), 'weight', 'Shipping weight', 'Shipping weight is required'),
    (l) => need(hasPrice(l), 'price', 'Price', 'Every variant needs a price above 0'),
  ],
  shopify: [
    (l) => need(!!l.title && l.title.length <= 255, 'title', 'Title', 'Title is required'),
    (l) => need(hasPrice(l), 'price', 'Price', 'Every variant needs a price'),
    (l) => need(l.productType !== 'variable' || l.variants.every((v) => Object.keys(v.options).length > 0),
      'variants.options', 'Variant options', 'Each variant of a variable product needs option values (e.g. color/size)'),
  ],
};

export function validateFor(code: MarketplaceCode, l: EffectiveListing, conn: Connection): MissingField[] {
  const out: MissingField[] = [];
  for (const rule of RULES[code]) {
    const r = rule(l, conn);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  }
  return out;
}
