import * as dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const DATABASE_URL = process.env.DATABASE_URL;

async function bootstrap() {
  console.log('[Reloop Worker] Starting worker skeleton service...');
  console.log(`[Reloop Worker] Configuration loaded (Redis: ${REDIS_URL}, Database configured: ${Boolean(DATABASE_URL)})`);

  let redis: Redis | null = null;
  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    await redis.connect();
    const pong = await redis.ping();
    console.log(`[Reloop Worker] Coordination infrastructure reachable (Redis PING -> ${pong})`);
  } catch (err) {
    console.warn('[Reloop Worker] Warning: Could not reach Redis on initial ping:', (err as Error).message);
  }

  console.log('[Reloop Worker] Service initialized in skeleton mode (no stream consumers active). Ready.');

  const shutdown = async (signal: string) => {
    console.log(`[Reloop Worker] Received ${signal}. Shutting down gracefully...`);
    if (redis) {
      await redis.quit().catch(() => {});
    }
    console.log('[Reloop Worker] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[Reloop Worker] Fatal error during bootstrap:', err);
  process.exit(1);
});
