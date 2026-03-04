// src/app.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter from './auth/register';
import loginRouter from './auth/login';
import adminRouter from './admin/pending';
import configRouter from './config/router';

dotenv.config();

const app = express();

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json());

// Health check for Railway
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Auth routes
app.use('/api/auth', authRouter);
app.use('/api/auth', loginRouter);

// Admin routes (protected by middleware inside pending.ts)
app.use('/api/admin', adminRouter);

// Config route (premium toggle)
app.use('/api/config', configRouter);

export default app;

