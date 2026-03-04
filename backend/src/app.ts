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

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());

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

