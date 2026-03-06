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
    origin: (origin, callback) => {
        // Allow all origins (browsers send Origin header, bots might not)
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json());

// Health check for Railway - Log to help debug 503
app.get('/api/health', (req, res) => {
    console.log(`[HealthCheck] ${req.method} from ${req.ip} - ${new Date().toISOString()}`);
    res.json({ status: 'ok', ts: Date.now() });
});

// Auth routes
app.use('/api/auth', authRouter);
app.use('/api/auth', loginRouter);

// Admin routes (protected by middleware inside pending.ts)
app.use('/api/admin', adminRouter);

// Config route (premium toggle)
app.use('/api/config', configRouter);

export default app;

