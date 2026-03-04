// src/redisClient.ts
import Redis from 'ioredis';

// Create a singleton Redis client. Adjust host/port via env vars if needed.
const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
const host = process.env.REDISHOST || process.env.REDIS_HOST || '127.0.0.1';
const port = Number(process.env.REDISPORT || process.env.REDIS_PORT) || 6379;
const password = process.env.REDISPASSWORD || process.env.REDIS_PASSWORD || undefined;

if (redisUrl) {
    console.log('Redis: Connecting via URL...');
} else {
    console.log(`Redis: Connecting to ${host}:${port}...`);
}

const redis = redisUrl
    ? new Redis(redisUrl)
    : new Redis({
        host,
        port,
        password,
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
        maxRetriesPerRequest: 3
    });

redis.on('connect', () => {
    console.log('🚀 Redis connected successfully');
});

redis.on('error', (err: any) => {
    console.error('❌ Redis error:', err.message);
});

export default redis;
