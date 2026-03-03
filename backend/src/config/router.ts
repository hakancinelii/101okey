// src/config/router.ts
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyAdmin } from '../middleware/auth';

const prisma = new PrismaClient();
const router = Router();

// Get current premium setting (any user can read)
router.get('/', async (_req: Request, res: Response) => {
    try {
        const config = await prisma.config.findFirst();
        // If no config row exists, create default
        if (!config) {
            const created = await prisma.config.create({ data: {} });
            return res.json({ premiumEnabled: created.premiumEnabled });
        }
        return res.json({ premiumEnabled: config.premiumEnabled });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Failed to fetch config' });
    }
});

// Update premium setting – admin only
router.post('/', verifyAdmin, async (req: Request, res: Response) => {
    const { premiumEnabled } = req.body;
    if (typeof premiumEnabled !== 'boolean') {
        return res.status(400).json({ error: 'premiumEnabled must be boolean' });
    }
    try {
        // Ensure a config row exists
        const existing = await prisma.config.findFirst();
        if (existing) {
            await prisma.config.update({ where: { id: existing.id }, data: { premiumEnabled } });
        } else {
            await prisma.config.create({ data: { premiumEnabled } });
        }
        return res.json({ premiumEnabled });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Failed to update config' });
    }
});

export default router;
