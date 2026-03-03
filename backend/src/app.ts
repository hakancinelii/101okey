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

const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://frontend-hakancinelis-projects.vercel.app',
    process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
    origin: (origin, callback) => {
        // allow no-origin requests (mobile/curl) and whitelisted origins
        if (!origin || allowedOrigins.some(o => origin.startsWith(o))) {
            callback(null, true);
        } else {
            callback(new Error(`CORS blocked: ${origin}`));
        }
    },
    credentials: true,
}));

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

