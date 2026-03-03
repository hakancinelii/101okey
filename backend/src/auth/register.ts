// src/auth/register.ts
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const router = Router();

router.post('/register', async (req: Request, res: Response) => {
    const { email, password, name } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    try {
        const hashed = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                password: hashed,
                name,
                role: 'USER',
                approved: true,
            },
        });
        // Do not issue token until admin approves
        return res.status(201).json({ message: 'User registered, pending admin approval' });
    } catch (e: any) {
        console.error(e);
        return res.status(500).json({ error: 'Registration failed' });
    }
});

export default router;
