import Redis from 'ioredis';
import { loadSchedulerConfig } from './config';

export async function inspectQueue(): Promise<void> {
  const config = loadSchedulerConfig();
  const redis = new Redis(config.redisUrl);

  try {
    console.log('=== Reloop Redis Streams Inspection ===');
    console.log(`Stream Key: ${config.jobStreamKey}`);
    console.log(`Consumer Group: ${config.jobConsumerGroup}`);
    console.log(`Redis URL: ${config.redisUrl}\n`);

    const streamExists = await redis.exists(config.jobStreamKey);
    if (!streamExists) {
      console.log(`Stream "${config.jobStreamKey}" does not exist yet.`);
      return;
    }

    // 1. XINFO STREAM
    console.log('--- [1] XINFO STREAM ---');
    try {
      const streamInfo = (await redis.xinfo('STREAM', config.jobStreamKey)) as any[];
      for (let i = 0; i < streamInfo.length; i += 2) {
        console.log(`  ${streamInfo[i]}: ${JSON.stringify(streamInfo[i + 1])}`);
      }
    } catch (err: unknown) {
      console.error('Error fetching XINFO STREAM:', err);
    }

    // 2. XINFO GROUPS
    console.log('\n--- [2] XINFO GROUPS ---');
    try {
      const groups = (await redis.xinfo('GROUPS', config.jobStreamKey)) as any[];
      if (groups.length === 0) {
        console.log('  No consumer groups registered.');
      } else {
        for (const grp of groups) {
          console.log(`  Group: ${JSON.stringify(grp)}`);
        }
      }
    } catch (err: unknown) {
      console.error('Error fetching XINFO GROUPS:', err);
    }

    // 3. XRANGE (latest 10 entries)
    console.log('\n--- [3] XRANGE (latest 10 entries) ---');
    try {
      const entries = await redis.xrange(config.jobStreamKey, '-', '+', 'COUNT', 10);
      if (entries.length === 0) {
        console.log('  Stream is empty (no entries).');
      } else {
        for (const [id, fields] of entries) {
          console.log(`  ID: ${id}, Fields: ${JSON.stringify(fields)}`);
        }
      }
    } catch (err: unknown) {
      console.error('Error fetching XRANGE:', err);
    }
  } finally {
    await redis.quit().catch(() => {});
  }
}

if (require.main === module) {
  inspectQueue().catch(console.error);
}