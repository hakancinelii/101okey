// src/admin/pending.ts
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyAdmin } from '../middleware/auth';

const prisma = new PrismaClient();
const router = Router();

// Get list of users awaiting approval (admin only)
router.get('/pending', verifyAdmin, async (_req: Request, res: Response) => {
    try {
        const pending = await prisma.user.findMany({ where: { approved: false } });
        return res.json(pending);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Failed to fetch pending users' });
    }
});

// Approve one or many users (admin only)
router.post('/approve', verifyAdmin, async (req: Request, res: Response) => {
    const { userIds } = req.body; // expect array of user IDs
    if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'userIds array required' });
    }
    try {
        await prisma.user.updateMany({
            where: { id: { in: userIds } },
            data: { approved: true },
        });
        return res.json({ message: 'Users approved' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Failed to approve users' });
    }
});

export default router;
