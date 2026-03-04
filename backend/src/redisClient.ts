// src/redisClient.ts
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
const host = process.env.REDISHOST || process.env.REDIS_HOST;
const hasRedisConfig = !!(redisUrl || host);

let redis: Redis;

if (hasRedisConfig) {
    const port = Number(process.env.REDISPORT || process.env.REDIS_PORT) || 6379;
    const password = process.env.REDISPASSWORD || process.env.REDIS_PASSWORD || undefined;

    if (redisUrl) {
        console.log('Redis: Connecting via URL...');
        redis = new Redis(redisUrl, {
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                if (times > 5) return null; // Stop retrying after 5 attempts
                return Math.min(times * 200, 2000);
            },
            lazyConnect: true
        });
    } else {
        console.log(`Redis: Connecting to ${host}:${port}...`);
        redis = new Redis({
            host: host!,
            port,
            password,
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                if (times > 5) return null; // Stop retrying after 5 attempts
                return Math.min(times * 200, 2000);
            },
            lazyConnect: true
        });
    }

    redis.connect().catch(() => {
        console.warn('⚠️ Redis connection failed. Running without cache.');
    });

    redis.on('connect', () => {
        console.log('🚀 Redis connected successfully');
    });

    redis.on('error', (err: any) => {
        // Log only once, not every retry
    });
} else {
    console.log('⚠️ No Redis configured. Running without cache (DB-only mode).');
    // Create a no-op stub that fulfills the interface
    redis = {
        get: async () => null,
        set: async () => 'OK',
        del: async () => 0,
        status: 'end'
    } as any;
}

export default redis;
