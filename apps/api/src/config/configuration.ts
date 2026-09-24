import { parseMasterEncryptionKey } from '@reloop/connector-shopify';

export default () => {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  const nodeEnv = process.env.NODE_ENV || 'development';

  if (!databaseUrl && nodeEnv !== 'test') {
    throw new Error('Configuration error: DATABASE_URL environment variable is required.');
  }

  if (!jwtAccessSecret && nodeEnv !== 'test') {
    throw new Error('Configuration error: JWT_ACCESS_SECRET environment variable is required.');
  }

  const shopifyClientId =
    process.env.SHOPIFY_CLIENT_ID || (nodeEnv === 'test' ? 'shopify_test_client_id' : '');
  const shopifyClientSecret =
    process.env.SHOPIFY_CLIENT_SECRET || (nodeEnv === 'test' ? 'shopify_test_client_secret_123' : '');
  const integrationEncryptionKey =
    process.env.INTEGRATION_ENCRYPTION_KEY ||
    (nodeEnv === 'test' ? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' : '');

  // Validate encryption key if provided or if Shopify integration is active
  if (integrationEncryptionKey) {
    try {
      parseMasterEncryptionKey(integrationEncryptionKey);
    } catch (err: any) {
      throw new Error(`Configuration error: INTEGRATION_ENCRYPTION_KEY is invalid: ${err.message}`);
    }
  } else if (shopifyClientId && nodeEnv !== 'test') {
    throw new Error(
      'Configuration error: INTEGRATION_ENCRYPTION_KEY is required when Shopify integration is enabled.',
    );
  }

  return {
    port: parseInt(process.env.API_PORT || '3101', 10),
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3100',
    databaseUrl,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6380',
    jwtAccessSecret,
    jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshSessionTtlDays: parseInt(process.env.REFRESH_SESSION_TTL_DAYS || '7', 10),
    refreshCookieName: process.env.REFRESH_COOKIE_NAME || 'reloop_refresh',
    simulatorWebhookSecret: process.env.SIMULATOR_WEBHOOK_SECRET || 'reloop_simulator_webhook_secret_dev',
    webhookMaxPayloadBytes: parseInt(process.env.WEBHOOK_MAX_PAYLOAD_BYTES || '1048576', 10),
    shopifyClientId,
    shopifyClientSecret,
    shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
    shopifyScopes: process.env.SHOPIFY_SCOPES || 'read_orders',
    shopifyRedirectUri: process.env.SHOPIFY_REDIRECT_URI || 'http://localhost:3101/integrations/shopify/callback',
    integrationEncryptionKey,
    shopifyInitialSyncMaxOrders: parseInt(process.env.SHOPIFY_INITIAL_SYNC_MAX_ORDERS || '250', 10),
    // API E2E suites share one database and explicitly exercise webhook processing.
    // Keep the periodic scanner opt-in under Jest so it cannot race suite cleanup.
    webhookScannerEnabled:
      process.env.WEBHOOK_SCANNER_ENABLED === undefined
        ? nodeEnv !== 'test'
        : process.env.WEBHOOK_SCANNER_ENABLED !== 'false',
    webhookScannerIntervalMs: parseInt(
      process.env.WEBHOOK_SCANNER_INTERVAL_MS || (nodeEnv === 'test' ? '100' : '2000'),
      10,
    ),
    webhookStaleThresholdMs: parseInt(process.env.WEBHOOK_STALE_THRESHOLD_MS || '60000', 10),
    webhookScannerBatchSize: parseInt(process.env.WEBHOOK_SCANNER_BATCH_SIZE || '50', 10),
    nodeEnv,
  };
};
