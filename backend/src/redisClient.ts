// src/redisClient.ts
import Redis from 'ioredis';

// Create a singleton Redis client. Adjust host/port via env vars if needed.
const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;

const redis = redisUrl
    ? new Redis(redisUrl)
    : new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
    });

redis.on('error', (err) => {
    console.error('Redis error:', err);
});

export default redis;
