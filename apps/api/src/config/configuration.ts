export default () => ({
  port: parseInt(process.env.API_PORT || '3101', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3100',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://reloop:reloop_dev_password@localhost:5433/reloop?schema=public',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6380',
});
