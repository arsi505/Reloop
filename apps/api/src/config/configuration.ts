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
    nodeEnv,
  };
};