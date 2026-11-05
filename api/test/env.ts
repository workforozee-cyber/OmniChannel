// Loaded by Jest before any test module (see jest.config.js) so config.ts sees these values.
process.env.NODE_ENV = 'test';
process.env.JOBS_INLINE = 'true';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/omnichannel_test';
process.env.SHOPIFY_CLIENT_SECRET = 'shpss_test_secret';
process.env.ETSY_WEBHOOK_SECRET = 'whsec_' + Buffer.from('etsy-test-secret').toString('base64');
