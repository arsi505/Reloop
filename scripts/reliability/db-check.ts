import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();
  const orgCount = await prisma.organization.count();
  console.log('PostgreSQL Connected successfully! Org count:', orgCount);
  await prisma.$disconnect();

  const redis = new Redis(redisUrl);
  const pong = await redis.ping();
  console.log('Redis Connected successfully! Ping response:', pong);
  await redis.quit();
}

main().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});
