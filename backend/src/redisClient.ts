// src/redisClient.ts
import Redis from 'ioredis';

// Create a singleton Redis client. Adjust host/port via env vars if needed.
const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
});

export default redis;
