// src/socket/index.ts
import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { PrismaClient, GameStatus, MoveType } from '@prisma/client';
import { verifyToken } from '../middleware/auth';
import { generateTilePool, shuffle, distributeTiles, calculateSetScore, calculateMultipleSetsScore, calculateHandPenalty } from '../game/logic';
import redis from '../redisClient';
import { Tile } from '../game/rules';

/**
 * Transaction helper: draw a tile and update Redis cache.
 */
async function drawTileTx(gameId: string, playerId: string) {
    return await prisma.$transaction(async (tx) => {
        const game = await tx.game.findUnique({ where: { id: gameId }, include: { members: true } });
        if (!game) throw new Error('Game not found');
        const member = game.members.find(m => m.userId === playerId);
        if (!member) throw new Error('Player not in game');
        const pool = (game.tilePool as any[]) ?? [];
        if (pool.length === 0) throw new Error('Pool empty');
        const drawn = pool.pop();
        const hand = (member.hand as any[]) ?? [];
        hand.push(drawn);
        await tx.gameMember.update({ where: { id: member.id }, data: { hand, hasDrawn: true } });
        await tx.game.update({ where: { id: gameId }, data: { tilePool: pool } });
        await tx.move.create({ data: { gameId, playerId, type: 'DRAW', payload: drawn } });
        await updateGameCache(gameId);
        return drawn;
    });
}

/**
 * Transaction helper: discard a tile and update Redis cache.
 */
async function discardTileTx(gameId: string, playerId: string, tileId: string) {
    return await prisma.$transaction(async (tx) => {
        const game = await tx.game.findUnique({ where: { id: gameId }, include: { members: true } });
        if (!game) throw new Error('Game not found');
        const member = game.members.find(m => m.userId === playerId);
        if (!member) throw new Error('Player not in game');
        const hand = (member.hand as any[]) ?? [];
        const idx = hand.findIndex(t => t.id === tileId);
        if (idx === -1) throw new Error('Tile not in hand');
        const discarded = hand.splice(idx, 1)[0];
        await tx.gameMember.update({ where: { id: member.id }, data: { hand, hasDrawn: false } });
        await tx.game.update({ where: { id: gameId }, data: { lastDiscard: discarded } });
        await tx.move.create({ data: { gameId, playerId, type: 'DISCARD', payload: discarded } });
        await updateGameCache(gameId);
        return discarded;
    });
}

/**
 * Transaction helper: place sets and update Redis cache.
 */
async function placeSetsTx(gameId: string, playerId: string, sets: Tile[][]) {
    return await prisma.$transaction(async (tx) => {
        const game = await tx.game.findUnique({ where: { id: gameId }, include: { members: true } });
        if (!game) throw new Error('Game not found');
        const member = game.members.find(m => m.userId === playerId);
        if (!member) throw new Error('Player not in game');
        const okey = game.okeyTile as any;
        for (const s of sets) {
            const { isValid } = calculateSetScore(s, okey);
            if (!isValid) throw new Error('Invalid set submitted');
        }
        const hand = (member.hand as any[]) ?? [];
        for (const s of sets) {
            for (const t of s) {
                const i = hand.findIndex(h => h.id === t.id);
                if (i !== -1) hand.splice(i, 1);
            }
        }
        const openSets = (member.openSets as any[]) ?? [];
        openSets.push(...sets);
        await tx.gameMember.update({ where: { id: member.id }, data: { hand, openSets, mustOpen: false } });
        await tx.move.create({ data: { gameId, playerId, type: 'SET', payload: { sets } as any } });
        await updateGameCache(gameId);
        return true;
    });
}


const prisma = new PrismaClient();
const botProcessingLock = new Map<string, boolean>();
const gameFinishLock = new Map<string, boolean>(); // New lock map
const turnStartTimes = new Map<string, number>(); // track when each game's turn started

/**
 * CommandQueue: Serializes actions per game to prevent race conditions
 * and ensure cache consistency.
 */
class CommandQueue {
    private static instance: CommandQueue;
    private queues = new Map<string, Promise<any>>();

    private constructor() { }

    public static getInstance() {
        if (!CommandQueue.instance) CommandQueue.instance = new CommandQueue();
        return CommandQueue.instance;
    }

    public enqueue<T>(gameId: string, action: () => Promise<T>): Promise<T> {
        const last = this.queues.get(gameId) || Promise.resolve();
        const next = last.then(action).catch((err) => {
            console.error(`CommandQueue Error [Game ${gameId}]:`, err);
            throw err;
        }).finally(() => {
            // Clean up if this was the last one in line
            if (this.queues.get(gameId) === next) {
                this.queues.delete(gameId);
            }
        });
        this.queues.set(gameId, next);
        return next;
    }
}

const commandQueue = CommandQueue.getInstance();


// Simple in‑memory rate‑limit map per socket (event → { ts, count })
const rateLimitMap = new Map<string, Map<string, { ts: number; count: number }>>();
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second window
const RATE_LIMIT_MAX = 5; // max 5 events per window per socket

function isRateLimited(socketId: string, eventName: string): boolean {
    const now = Date.now();
    let socketMap = rateLimitMap.get(socketId);
    if (!socketMap) {
        socketMap = new Map();
        rateLimitMap.set(socketId, socketMap);
    }
    const entry = socketMap.get(eventName);
    if (!entry) {
        socketMap.set(eventName, { ts: now, count: 1 });
        return false;
    }
    if (now - entry.ts > RATE_LIMIT_WINDOW_MS) {
        // reset window
        entry.ts = now;
        entry.count = 1;
        return false;
    }
    if (entry.count >= RATE_LIMIT_MAX) {
        return true;
    }
    entry.count += 1;
    return false;
}

// Helper to push the latest game state to Redis (as JSON string)
async function updateGameCache(gameId: string) {
    try {
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: { members: true, moves: false }
        });
        if (!game) return;
        await redis.set(`game:${gameId}`, JSON.stringify(game));
    } catch (e) {
        console.error('Redis Cache Update Error (Non-blocking):', e);
    }
}


/**
 * Initialize Socket.IO server.
 * Attach to an existing HTTP server (Express app).
 */
export const initSocket = (httpServer: HttpServer) => {
    const io = new SocketIOServer(httpServer, {
        cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
    });

    async function handleGameFinish(gameId: string, reason: string) {
        if (gameFinishLock.get(gameId)) return;
        gameFinishLock.set(gameId, true);
        try {
            const game = await prisma.game.findUnique({
                where: { id: gameId },
                include: { members: true }
            });
            if (!game || game.status === 'FINISHED' || game.status === 'PENDING') {
                gameFinishLock.delete(gameId);
                return;
            }
            const isFinalRound = game.currentRound >= game.maxRounds;
            const okeyTile = game.okeyTile as any;
            const updates = [];
            for (const m of game.members) {
                const hand = (m.hand as any) || [];
                const penalty = calculateHandPenalty(hand, okeyTile, m.openScore > 0);
                updates.push(prisma.gameMember.update({
                    where: { id: m.id },
                    data: { penaltyScore: penalty, totalPenaltyScore: { increment: penalty } }
                }));
            }
            await prisma.$transaction([
                prisma.game.update({
                    where: { id: gameId },
                    data: { status: isFinalRound ? 'FINISHED' : 'PENDING', finishedAt: new Date() }
                }),
                ...updates
            ]);
            const updatedMembers = await prisma.gameMember.findMany({
                where: { gameId },
                include: { user: true }
            });
            io.to(gameId).emit('gameFinished', {
                reason,
                currentRound: game.currentRound,
                maxRounds: game.maxRounds,
                isFinal: isFinalRound,
                members: updatedMembers.map(um => ({
                    userId: um.userId,
                    name: um.user?.name || um.user?.email || 'Player',
                    penaltyScore: um.penaltyScore,
                    totalPenaltyScore: um.totalPenaltyScore,
                    openScore: um.openScore
                }))
            });
            // Also update cache as finished
            await updateGameCache(gameId);
        } catch (e) {
            console.error('Error in handleGameFinish:', e);
        } finally {
            setTimeout(() => gameFinishLock.delete(gameId), 2000);
        }
    }

    async function forceAutoMove(gameId: string) {
        commandQueue.enqueue(gameId, async () => {
            try {
                const game = await prisma.game.findUnique({
                    where: { id: gameId },
                    include: { members: { orderBy: { seat: 'asc' } } }
                });
                if (!game || game.status !== 'ACTIVE') return;
                const currentMember = game.members[game.turnIndex];
                if (!currentMember) return;
                let pool = (game.tilePool as any) || [];
                let currentHand = (currentMember.hand as any) || [];
                let hasDrawn = currentMember.hasDrawn;
                if (!hasDrawn) {
                    if (pool.length > 0) {
                        const tile = pool.shift();
                        currentHand.push(tile);
                        hasDrawn = true;
                    } else {
                        await handleGameFinish(gameId, 'DEST_BITTI');
                        return;
                    }
                }
                const discardedTile = currentHand.pop();
                const nextTurn = (game.turnIndex + 1) % game.members.length;
                await prisma.$transaction([
                    prisma.game.update({
                        where: { id: gameId },
                        data: { tilePool: pool as any, turnIndex: nextTurn, lastDiscard: discardedTile as any }
                    }),
                    prisma.gameMember.update({
                        where: { id: currentMember.id },
                        data: { hand: currentHand, hasDrawn: false, mustOpen: false } as any
                    }),
                    prisma.gameMember.update({
                        where: { id: game.members[nextTurn].id },
                        data: { hasDrawn: false, mustOpen: false } as any
                    })
                ]);
                await updateGameCache(gameId);
                io.to(gameId).emit('poolUpdate', { deckCount: pool.length });
                io.to(gameId).emit('tileDiscarded', { userId: currentMember.userId, tile: discardedTile });
                io.to(gameId).emit('turnUpdate', { turnIndex: nextTurn });
                turnStartTimes.set(gameId, Date.now());
                setTimeout(() => checkAndProcessBotTurn(gameId), 2000);
            } catch (e) {
                console.error('Error in forceAutoMove:', e);
            }
        });
    }

    async function checkAndProcessBotTurn(gameId: string) {
        if (botProcessingLock.get(gameId)) return;
        botProcessingLock.set(gameId, true);
        commandQueue.enqueue(gameId, async () => {
            try {
                const game = await prisma.game.findUnique({
                    where: { id: gameId },
                    include: { members: { include: { user: true }, orderBy: { seat: 'asc' } } }
                });
                if (!game || game.status !== 'ACTIVE') {
                    botProcessingLock.delete(gameId);
                    return;
                }
                const currentMember = game.members[game.turnIndex];
                if (!currentMember || !currentMember.isBot) {
                    botProcessingLock.delete(gameId);
                    return;
                }
                const pool = (game.tilePool as any) || [];
                if (pool.length === 0) {
                    await handleGameFinish(gameId, 'DEST_BITTI');
                    botProcessingLock.delete(gameId);
                    return;
                }
                const currentHand = (currentMember.hand as any) || [];
                const drawnTile = pool.shift();
                const updatedHand = [...currentHand, drawnTile];
                const okeyTile = game.okeyTile as any;
                let discardIndex = 0;
                if (updatedHand.length > 1) {
                    const nonOkeyIdx = updatedHand.findIndex(t => !(t.color === okeyTile.color && t.number === okeyTile.number));
                    if (nonOkeyIdx !== -1) discardIndex = nonOkeyIdx;
                }
                const discardedTile = updatedHand[discardIndex];
                updatedHand.splice(discardIndex, 1);
                const nextTurn = (game.turnIndex + 1) % game.members.length;
                await prisma.$transaction([
                    prisma.game.update({
                        where: { id: gameId },
                        data: { tilePool: pool as any, turnIndex: nextTurn, lastDiscard: discardedTile as any }
                    }),
                    prisma.gameMember.update({
                        where: { id: currentMember.id },
                        data: { hand: updatedHand, hasDrawn: false, mustOpen: false } as any
                    }),
                    prisma.gameMember.update({
                        where: { id: game.members[nextTurn].id },
                        data: { hasDrawn: false, mustOpen: false } as any
                    })
                ]);
                io.to(gameId).emit('poolUpdate', { deckCount: pool.length });
                io.to(gameId).emit('tileDiscarded', { userId: currentMember.userId, tile: discardedTile });
                io.to(gameId).emit('turnUpdate', { turnIndex: nextTurn });
                turnStartTimes.set(gameId, Date.now());
                botProcessingLock.delete(gameId);
                const nextMember = game.members[nextTurn];
                if (nextMember && nextMember.isBot) {
                    // Consistent 3-5s for bot->bot
                    setTimeout(() => checkAndProcessBotTurn(gameId), 3000 + Math.random() * 2000);
                }
                await updateGameCache(gameId);
            } catch (e) {
                console.error('Error in checkAndProcessBotTurn:', e);
                botProcessingLock.delete(gameId);
            }
        });
    }

    async function turnSupervisor() {
        try {
            const activeGames = await prisma.game.findMany({
                where: { status: 'ACTIVE' },
                include: { members: true }
            });
            for (const game of activeGames) {
                const startTime = turnStartTimes.get(game.id);
                if (startTime) {
                    const elapsed = Date.now() - startTime;
                    const config = (game.config as any) || {};
                    const turnTimeout = (config.turnTime || 80) * 1000;

                    if (elapsed > turnTimeout) {
                        console.log(`[Supervisor] Timeout for game ${game.id}. Forcing move.`);
                        forceAutoMove(game.id).catch(e => console.error(e));
                    } else {
                        const currentMember = game.members[game.turnIndex];
                        // If bot is stuck for more than 15s, poke it
                        if (currentMember && currentMember.isBot && elapsed > 15000) {
                            console.log(`[Supervisor] Bot boost for game ${game.id}`);
                            checkAndProcessBotTurn(game.id).catch(e => console.error(e));
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error in turnSupervisor:', e);
        }
    }


    // Middleware to verify JWT on each socket connection
    io.use(async (socket: Socket, next) => {
        const token = socket.handshake.auth?.token;
        console.log(`Socket auth attempt with token: ${token?.substring(0, 10)}...`);

        if (!token) {
            console.log('Socket connectivity: Missing token');
            return next(new Error('Missing token'));
        }

        try {
            const secret = process.env.JWT_SECRET;
            if (!secret) {
                console.error('JWT_SECRET is UNDEFINED in socket middleware!');
                return next(new Error('Server configuration error'));
            }

            const jwt = await import('jsonwebtoken');
            const payload = jwt.verify(token, secret);
            // @ts-ignore
            socket.user = payload;
            console.log('Socket auth success for user:', (payload as any).userId);
            next();
        } catch (e: any) {
            console.error('Socket JWT Verify Error:', e.message);
            next(new Error('Invalid token'));
        }
    });

    // ---------- Lobby handling ----------
    io.on('connection', (socket) => {
        const userId = (socket as any).user?.userId;
        console.log(`Socket connected: ${socket.id} (user ${userId})`);

        // Start Supervisor if not already running (static-like check)
        if (!(global as any).botSupervisorStarted) {
            (global as any).botSupervisorStarted = true;
            setInterval(turnSupervisor, 5000); // Check every 5s for better responsiveness
        }

        // Helper to emit full member list
        const emitLobbyUpdate = async (lobbyId: string) => {
            const members = await prisma.gameMember.findMany({
                where: { gameId: lobbyId },
                include: { user: true }
            });
            const game = await prisma.game.findUnique({ where: { id: lobbyId } });

            const memberList = members.map(m => ({
                id: m.userId,
                name: m.isBot ? `🤖 ${m.user.name}` : m.user.name || m.user.email,
                ready: m.isReady,
                isBot: m.isBot,
                seat: m.seat,
                host: m.userId === game?.hostId
            }));

            // Send settings along with lobby update
            const settings = (game?.config as any) || {
                maxRounds: game?.maxRounds || 3,
                turnTime: 60,
                gameMode: 'NORMAL',
                startingScore: 101
            };

            io.to(lobbyId).emit('lobbyUpdate', { members: memberList, settings });
        };

        // Join a lobby (room) – lobbyId is the Game.id (pending game)
        socket.on('joinLobby', async (lobbyId: string, callback: (err?: string) => void) => {
            try {
                let gameRec = await prisma.game.findUnique({
                    where: { id: lobbyId },
                    include: { members: { include: { user: true } } }
                });

                if (!gameRec) {
                    // Create new lobby
                    gameRec = await prisma.game.create({
                        data: { id: lobbyId, hostId: userId, status: 'PENDING' },
                        include: { members: { include: { user: true } } }
                    });
                } else if (gameRec.status === 'FINISHED') {
                    // Reincarnate finished game as a new lobby
                    await prisma.$transaction([
                        prisma.game.update({
                            where: { id: lobbyId },
                            data: {
                                status: 'PENDING',
                                hostId: userId,
                                tilePool: null,
                                okeyTile: null,
                                turnIndex: 0,
                                lastDiscard: null,
                                startedAt: null,
                                finishedAt: null
                            } as any
                        }),
                        prisma.gameMember.deleteMany({ where: { gameId: lobbyId } })
                    ]);
                    gameRec = await prisma.game.findUnique({
                        where: { id: lobbyId },
                        include: { members: { include: { user: true } } }
                    });
                }

                const game = gameRec!;

                // If host is no longer in members, assign a new host (or this user)
                const hostPresent = game.members.some(m => m.userId === game.hostId);
                if (!hostPresent && game.status === 'PENDING') {
                    await prisma.game.update({
                        where: { id: lobbyId },
                        data: { hostId: userId }
                    });
                }

                const isMember = game.members.some(m => m.userId === userId);

                if (game.status === 'ACTIVE' && !isMember) {
                    return callback?.('Oyun devam ediyor, katılamazsınız.');
                }

                // Add member if not already present
                if (!isMember) {
                    const currentMembers = await prisma.gameMember.findMany({ where: { gameId: lobbyId } });

                    if (currentMembers.length >= 4) {
                        // Special Handling: Public lobby (default) or lobbies with bots
                        const botToReplace = currentMembers.find(m => m.isBot);
                        if (botToReplace) {
                            console.log(`Replacing bot ${botToReplace.userId} for user ${userId} in lobby ${lobbyId}`);
                            const botHand = botToReplace.hand;
                            await prisma.gameMember.delete({ where: { id: botToReplace.id } });

                            await prisma.gameMember.create({
                                data: {
                                    gameId: lobbyId,
                                    userId,
                                    seat: botToReplace.seat,
                                    isReady: false,
                                    hand: botHand as any
                                }
                            });
                        } else {
                            return callback?.('Masa dolu');
                        }
                    } else {
                        // Find lowest available seat
                        const seats = [0, 1, 2, 3];
                        const occupied = currentMembers.map(m => m.seat);
                        const seat = seats.find(s => !occupied.includes(s)) ?? currentMembers.length;

                        await prisma.gameMember.create({
                            data: { gameId: lobbyId, userId, seat, isReady: false }
                        });
                    }
                }

                socket.join(lobbyId);
                await emitLobbyUpdate(lobbyId);

                // Reload game record to ensure all checks pass (and seat assignments are reflected)
                const gameAfterJoin = await prisma.game.findUnique({
                    where: { id: lobbyId },
                    include: { members: { include: { user: true } } }
                });
                if (!gameAfterJoin) return callback?.('Lobby state error');

                // If game is active and user is returning, send gameStarted
                if (gameAfterJoin.status === 'ACTIVE') {
                    const playerList = gameAfterJoin.members.map((m: any) => ({
                        userId: m.userId,
                        name: m.user?.name || m.user?.email || 'Player',
                        seat: m.seat,
                        openScore: m.openScore || 0,
                        openSets: m.openSets || [],
                        penaltyScore: m.penaltyScore || 0
                    }));

                    const member = gameAfterJoin.members.find(m => m.userId === userId);
                    socket.emit('gameStarted', {
                        gameId: lobbyId,
                        hand: (member as any)?.hand || [],
                        okeyTile: gameAfterJoin.okeyTile as any,
                        deckCount: (gameAfterJoin.tilePool as any)?.length || 0,
                        turnIndex: gameAfterJoin.turnIndex,
                        members: playerList
                    });
                }

                callback?.();
            } catch (e) {
                console.error('JoinLobby Error:', e);
                callback?.('Sunucu hatası');
            }
        });

        // Ready toggle
        socket.on('setReady', async (data: any, callback?: (err?: string) => void) => {
            try {
                // Support both old boolean-only and new object format for grace period
                const targetLobbyId = typeof data === 'object' ? data.lobbyId : null;
                const isReady = typeof data === 'object' ? data.isReady : data;

                let member;
                if (targetLobbyId) {
                    member = await prisma.gameMember.findFirst({
                        where: { userId, gameId: targetLobbyId }
                    });
                } else {
                    // Fallback for older clients (pick most recent)
                    member = await prisma.gameMember.findFirst({
                        where: { userId },
                        orderBy: { game: { createdAt: 'desc' } }
                    });
                }

                if (!member) return callback?.('Not in a lobby');

                await prisma.gameMember.update({
                    where: { id: member.id },
                    data: { isReady }
                });

                await emitLobbyUpdate(member.gameId);
                callback?.();
            } catch (e) {
                console.error('setReady Error:', e);
                callback?.('Server error');
            }
        });
        // Add a bot to the lobby
        socket.on('addBot', async (lobbyId: string, callback?: (err?: string) => void) => {
            try {
                const game = await prisma.game.findUnique({ where: { id: lobbyId }, include: { members: true } });
                if (!game || game.hostId !== userId) return callback?.('Only host can add bots');

                const freshMembers = await prisma.gameMember.findMany({ where: { gameId: lobbyId } });
                console.log(`AddBot Debug: Lobby ${lobbyId} has ${freshMembers.length} members`);
                if (freshMembers.length >= 4) {
                    console.log('Members:', freshMembers.map(m => ({ id: m.userId, isBot: m.isBot })));
                    return callback?.('Lobby full');
                }

                // Find the first empty seat (0-3)
                const seats = [0, 1, 2, 3];
                const occupiedSeats = freshMembers.map(m => m.seat);
                const nextSeat = seats.find(s => !occupiedSeats.includes(s));

                if (nextSeat === undefined) return callback?.('Lobby full');

                // Find or create a bot user
                const botEmail = `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}@okey.ai`;
                const botUser = await prisma.user.create({
                    data: {
                        email: botEmail,
                        password: 'bot_password_not_used',
                        name: `Bot ${Date.now().toString().slice(-4)}`,
                        approved: true
                    }
                });

                await prisma.gameMember.create({
                    data: {
                        gameId: lobbyId,
                        userId: botUser.id,
                        seat: nextSeat,
                        isReady: true,
                        isBot: true
                    }
                });

                await emitLobbyUpdate(lobbyId);
                callback?.();
            } catch (e) {
                console.error(e);
                callback?.('Server error');
            }
        });

        // Remove a bot from the lobby
        socket.on('removeBot', async (botUserId: string, callback?: (err?: string) => void) => {
            try {
                const member = await prisma.gameMember.findFirst({ where: { userId }, include: { game: true } });
                if (!member || member.game.hostId !== userId) return callback?.('Only host can remove bots');

                const botMember = await prisma.gameMember.findFirst({
                    where: { gameId: member.gameId, userId: botUserId, isBot: true }
                });
                if (!botMember) return callback?.('Bot not found');

                await prisma.gameMember.delete({ where: { id: botMember.id } });
                await emitLobbyUpdate(member.gameId);
                callback?.();
            } catch (e) {
                console.error(e);
                callback?.('Server error');
            }
        });

        // Reset a game to PENDING status
        socket.on('resetGame', async (lobbyId: string, callback?: (err?: string) => void) => {
            try {
                const game = await prisma.game.findUnique({ where: { id: lobbyId } });
                if (!game || game.hostId !== userId) return callback?.('Only host can reset game');

                await prisma.$transaction([
                    prisma.game.update({
                        where: { id: lobbyId },
                        data: {
                            status: 'PENDING',
                            tilePool: null,
                            okeyTile: null,
                            lastDiscard: null,
                            turnIndex: 0
                        } as any
                    }),
                    // DELETE ALL EXCEPT HOST to ensure a truly fresh start
                    prisma.gameMember.deleteMany({
                        where: {
                            gameId: lobbyId,
                            userId: { not: userId }
                        }
                    }),
                    prisma.gameMember.updateMany({
                        where: { gameId: lobbyId, userId: userId },
                        data: {
                            hand: null,
                            openScore: 0,
                            openSets: [] as any,
                            hasDrawn: false,
                            mustOpen: false,
                            penaltyScore: 0,
                            isReady: false
                        } as any
                    })
                ]);

                await emitLobbyUpdate(lobbyId);
                io.to(lobbyId).emit('chatMessage', { user: 'SYSTEM', text: 'Masa sıfırlandı.' });
                callback?.();
            } catch (e) {
                console.error(e);
                callback?.('Server error');
            }
        });

        // Host starts the game when all 4 are ready
        socket.on('startGame', async (lobbyId: string, options: any, callback?: (err?: string) => void) => {
            try {
                const actualCallback = typeof options === 'function' ? options : callback;

                const game = await prisma.game.findUnique({ where: { id: lobbyId } });
                if (!game) return actualCallback?.('Masa bulunamadı');
                if (game.hostId !== userId) return actualCallback?.('Sadece masa sahibi başlatabilir');

                const opts = (game.config as any) || {};
                const maxRounds = opts.maxRounds || game.maxRounds || 3;

                const members = await prisma.gameMember.findMany({
                    where: { gameId: lobbyId },
                    orderBy: { seat: 'asc' },
                    include: { user: true }
                });

                // Auto-ready bots for start
                const botIds = members.filter(m => m.isBot).map(m => m.id);
                if (botIds.length > 0) {
                    await prisma.gameMember.updateMany({
                        where: { id: { in: botIds } },
                        data: { isReady: true }
                    });
                }

                if (members.some((m) => !m.isReady && !m.isBot)) {
                    console.log('Ready check failed for lobby:', lobbyId);
                    return actualCallback?.('Tüm oyuncuların hazır olması gerekiyor');
                }

                await prisma.$transaction([
                    prisma.game.update({
                        where: { id: lobbyId },
                        data: { maxRounds }
                    }),
                    prisma.gameMember.updateMany({
                        where: { gameId: lobbyId },
                        data: {
                            penaltyScore: 0,
                            totalPenaltyScore: 0,
                            openScore: 0,
                            openSets: [] as any,
                            mustOpen: false
                        }
                    })
                ]);

                // Start first round
                await startRound(lobbyId, 1);
                actualCallback?.();
            } catch (e) {
                console.error(e);
                const actualCallback = typeof options === 'function' ? options : callback;
                actualCallback?.('Server error');
            }
        });

        socket.on('updateSettings', async (data: { lobbyId: string, settings: any }, callback?: (err?: string) => void) => {
            try {
                const game = await prisma.game.findUnique({ where: { id: data.lobbyId } });
                if (!game || game.hostId !== userId) return callback?.('Unauthorized');

                await prisma.game.update({
                    where: { id: data.lobbyId },
                    data: {
                        config: data.settings,
                        maxRounds: data.settings.maxRounds || 3
                    }
                });

                await emitLobbyUpdate(data.lobbyId);
                callback?.();
            } catch (e) {
                console.error(e);
                callback?.('Error updating settings');
            }
        });

        async function startRound(gameId: string, roundNumber: number) {
            const game = await prisma.game.findUnique({
                where: { id: gameId },
                include: { members: { include: { user: true } } }
            });
            if (!game) return;

            const members = game.members.sort((a, b) => a.seat - b.seat);
            const gameSeed = gameId + '-' + Date.now() + '-' + roundNumber;
            let pool = shuffle(generateTilePool(gameSeed));
            const indicator = pool.pop();
            const okeyTile = indicator ? {
                ...indicator,
                number: indicator.number === 13 ? 1 : indicator.number + 1
            } : null;

            const { hands, remainingPool } = distributeTiles(pool, members.length);

            await prisma.$transaction([
                prisma.game.update({
                    where: { id: gameId },
                    data: {
                        status: 'ACTIVE',
                        startedAt: new Date(),
                        tilePool: remainingPool as any,
                        okeyTile: okeyTile as any,
                        turnIndex: 0,
                        currentRound: roundNumber,
                        lastDiscard: null
                    } as any
                }),
                ...members.map((m, idx) =>
                    prisma.gameMember.update({
                        where: { id: m.id },
                        data: {
                            hand: hands[idx] as any,
                            hasDrawn: idx === 0,
                            openScore: 0,
                            openSets: [] as any,
                            mustOpen: false,
                            penaltyScore: 0,
                            isReady: false
                        } as any
                    })
                )
            ]);

            // Track turn start
            turnStartTimes.set(gameId, Date.now());

            // Sync to Redis
            await updateGameCache(gameId);

            const allSockets = await io.in(gameId).fetchSockets();

            for (const s of allSockets) {
                const sUserId = (s as any).user?.userId;
                const idx = members.findIndex(mem => mem.userId === sUserId);
                if (idx !== -1) {
                    s.emit('gameStarted', {
                        gameId: gameId,
                        hand: hands[idx],
                        deckCount: remainingPool.length,
                        okeyTile,
                        turnIndex: 0,
                        currentRound: roundNumber,
                        maxRounds: game.maxRounds,
                        members: members.map(m => ({
                            userId: m.userId,
                            name: m.isBot ? `🤖 ${m.user.name}` : m.user.name || m.user.email,
                            seat: m.seat,
                            isBot: m.isBot,
                            totalPenaltyScore: m.totalPenaltyScore
                        }))
                    });
                }
            }
            setTimeout(() => checkAndProcessBotTurn(gameId), 2000);
        }

        socket.on('startNextRound', async (gameId: string, callback?: (err?: string) => void) => {
            try {
                const game = await prisma.game.findUnique({ where: { id: gameId } });
                if (!game || game.hostId !== userId) return callback?.('Unauthorized');
                if (game.currentRound >= game.maxRounds) return callback?.('Game is already finished');

                await startRound(gameId, game.currentRound + 1);
                callback?.();
            } catch (e) {
                console.error(e);
                callback?.('Server error');
            }
        });

        // Join active game
        socket.on('joinGame', async (gameId: string, callback?: (err?: string) => void) => {
            try {
                // Try cache first
                let game: any;
                try {
                    const cached = await redis.get(`game:${gameId}`);
                    if (cached) {
                        game = JSON.parse(cached);
                    }
                } catch (e) {
                    console.warn('Redis read failed, falling back to DB:', e);
                }

                if (!game) {
                    game = await prisma.game.findUnique({
                        where: { id: gameId },
                        include: { members: { include: { user: true } } }
                    });
                    if (game) {
                        // Attempt to update cache (will be caught by try-catch in updateGameCache)
                        await updateGameCache(gameId);
                    }
                }

                if (!game || game.status !== 'ACTIVE') return callback?.('Game not found or not active');

                const member = game.members.find((m: any) => m.userId === userId);
                if (!member) return callback?.('Not a member of this game');

                socket.join(gameId);

                const playerList = game.members.map((m: any) => ({
                    userId: m.userId,
                    name: m.user?.name || m.user?.email || (m.isBot ? 'Bot' : 'Player'),
                    seat: m.seat,
                    openSets: m.openSets || [],
                    openScore: m.openScore || 0,
                    penaltyScore: m.penaltyScore || 0
                }));

                socket.emit('gameState', {
                    hand: member.hand as any,
                    board: [],
                    deckCount: (game.tilePool as any)?.length || 0,
                    okeyTile: game.okeyTile as any,
                    turnIndex: game.turnIndex,
                    lastDiscard: game.lastDiscard as any,
                    members: playerList
                });

                callback?.();
                setTimeout(() => checkAndProcessBotTurn(gameId), 1000);
            } catch (e) {
                console.error('joinGame error:', e);
                callback?.('Server error');
            }
        });

        // ---------- In‑game actions ----------
        socket.on('drawTile', async (callback: (tile?: any, err?: string) => void) => {
            const gameRooms = [...socket.rooms].filter(r => r !== socket.id);
            const activeGameId = gameRooms[gameRooms.length - 1];
            if (!activeGameId) return callback?.(undefined, 'Not in a game room');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    // Rate limiting
                    if (isRateLimited(socket.id, 'drawTile')) return callback?.(undefined, 'Too many draw requests');

                    const game = await prisma.game.findUnique({
                        where: { id: activeGameId },
                        include: { members: { orderBy: { seat: 'asc' } } }
                    }) as any;
                    if (!game || game.status !== 'ACTIVE') return callback?.(undefined, 'Game not active');

                    const member = game.members.find((m: any) => m.userId === userId);
                    if (!member) return callback?.(undefined, 'Not in this game');

                    const myIdx = game.members.findIndex((m: any) => m.userId === userId);
                    if (game.turnIndex !== myIdx) return callback?.(undefined, 'Not your turn');

                    const pool = (game.tilePool as any) as any[];
                    if (!pool || pool.length === 0) return callback?.(undefined, 'Deck empty');
                    if (member.hasDrawn) return callback?.(undefined, 'Already drawn');

                    const drawnTile = pool.shift();
                    const updatedHand = [...((member.hand as any) || []), drawnTile];

                    await prisma.$transaction([
                        prisma.game.update({ where: { id: activeGameId }, data: { tilePool: pool } as any }),
                        prisma.gameMember.update({ where: { id: member.id }, data: { hand: updatedHand, hasDrawn: true } as any })
                    ]);

                    // Update Redis cache
                    await updateGameCache(activeGameId);

                    io.to(activeGameId).emit('poolUpdate', { deckCount: pool.length });

                    // IMPORTANT: Reset turn timer on draw so player has time to think/place sets
                    turnStartTimes.set(activeGameId, Date.now());

                    callback(drawnTile);
                } catch (e) {
                    console.error(e);
                    callback?.(undefined, 'Server error');
                }
            });
        });

        socket.on('discardTile', async (tileId: string, callback?: (err?: string) => void) => {
            const gameRooms = [...socket.rooms].filter(r => r !== socket.id);
            const activeGameId = gameRooms[gameRooms.length - 1];
            if (!activeGameId) return callback?.('Not in a game room');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    // Rate limiting
                    if (isRateLimited(socket.id, 'discardTile')) return callback?.('Too many discard requests');

                    const game = await prisma.game.findUnique({
                        where: { id: activeGameId },
                        include: { members: { orderBy: { seat: 'asc' } } }
                    }) as any;
                    if (!game || game.status !== 'ACTIVE') return callback?.('Game not active');

                    const member = game.members.find((m: any) => m.userId === userId);
                    if (!member) return callback?.('Not in this game');

                    const members = game.members;
                    const myIdx = members.findIndex((m: any) => m.userId === userId);

                    if (game.turnIndex !== myIdx) return callback?.('Sıra sizde değil');
                    if (!member.hasDrawn) return callback?.('Önce taş çekmelisiniz');
                    if (member.mustOpen) return callback?.('Yan taşı aldığınız için yere per açmak zorundasınız');

                    const currentHand = (member.hand as any) || [];
                    const discardedTile = currentHand.find((t: any) => t.id === tileId);
                    if (!discardedTile) return callback?.('Tile not in hand');
                    const updatedHand = currentHand.filter((t: any) => t.id !== tileId);

                    const nextTurn = (game.turnIndex + 1) % members.length;

                    await prisma.$transaction([
                        prisma.gameMember.update({ where: { id: member.id }, data: { hand: updatedHand, hasDrawn: false, mustOpen: false } as any }),
                        prisma.game.update({
                            where: { id: activeGameId },
                            data: {
                                turnIndex: nextTurn,
                                lastDiscard: discardedTile as any
                            } as any
                        }),
                        prisma.gameMember.update({
                            where: { id: members[nextTurn].id },
                            data: { hasDrawn: false, mustOpen: false } as any
                        })
                    ]);

                    io.to(activeGameId).emit('tileDiscarded', { userId, tile: discardedTile });
                    io.to(activeGameId).emit('turnUpdate', { turnIndex: nextTurn });

                    // Track turn start
                    turnStartTimes.set(activeGameId, Date.now());

                    // If next player is bot, trigger delay (consistent 2-4s for human->bot)
                    setTimeout(() => checkAndProcessBotTurn(activeGameId), 2000 + Math.random() * 2000);

                    // Update Redis cache
                    await updateGameCache(activeGameId);

                    callback?.();
                } catch (e) {
                    console.error(e);
                    callback?.('Server error');
                }
            });
        });

        socket.on('drawDiscard', async (callback: (tile?: any, err?: string) => void) => {
            const member = await prisma.gameMember.findFirst({ where: { userId }, include: { game: true } });
            if (!member) return callback?.(undefined, 'Not in a game');
            const gameId = member.gameId;

            commandQueue.enqueue(gameId, async () => {
                try {
                    // Rate limiting
                    if (isRateLimited(socket.id, 'drawDiscard')) return callback?.(undefined, 'Too many drawDiscard requests');

                    const game = await prisma.game.findUnique({
                        where: { id: gameId },
                        include: { members: { orderBy: { seat: 'asc' } } }
                    }) as any;

                    if (!game.lastDiscard) return callback?.(undefined, 'No tile to draw');

                    const members = game.members;
                    const myIdx = members.findIndex((m: any) => m.userId === userId);
                    if (game.turnIndex !== myIdx) return callback?.(undefined, 'Not your turn');
                    if ((member as any).hasDrawn) return callback?.(undefined, 'Already drawn a tile');

                    const currentHand = (member.hand as any) || [];
                    const drawnTile = game.lastDiscard;
                    const updatedHand = [...currentHand, drawnTile];

                    await prisma.$transaction([
                        prisma.gameMember.update({ where: { id: member.id }, data: { hand: updatedHand, hasDrawn: true, mustOpen: true } as any }),
                        prisma.game.update({ where: { id: gameId }, data: { lastDiscard: null } as any })
                    ]);

                    // Update Redis cache
                    await updateGameCache(gameId);

                    // IMPORTANT: Reset turn timer on draw
                    turnStartTimes.set(gameId, Date.now());

                    io.to(gameId).emit('discardDrawn', { userId, tile: drawnTile });
                    callback(drawnTile);
                } catch (e) {
                    console.error(e);
                    callback?.(undefined, 'Server error');
                }
            });
        });

        socket.on('undoDrawDiscard', async (tileId: string, callback?: (err?: string) => void) => {
            const member = await prisma.gameMember.findFirst({
                where: { userId },
                include: { game: true }
            });
            if (!member || !member.mustOpen) return callback?.('Geri verilecek taş bulunamadı');
            const gameId = member.gameId;

            commandQueue.enqueue(gameId, async () => {
                try {
                    // Rate limiting
                    if (isRateLimited(socket.id, 'undoDrawDiscard')) return callback?.('Too many undo requests');

                    const currentHand = (member.hand as any) || [];
                    const tileToReturn = currentHand.find((t: any) => t.id === tileId);
                    if (!tileToReturn) return callback?.('Taş listenizde bulunamadı');

                    const updatedHand = currentHand.filter((t: any) => t.id !== tileId);
                    const newPenalty = ((member as any).penaltyScore || 0) + 101; // Penalty for undoing pick

                    await prisma.$transaction([
                        prisma.gameMember.update({
                            where: { id: member.id },
                            data: {
                                hand: updatedHand,
                                hasDrawn: false,
                                mustOpen: false,
                                penaltyScore: newPenalty
                            } as any
                        }),
                        prisma.game.update({
                            where: { id: gameId },
                            data: { lastDiscard: tileToReturn } as any
                        })
                    ]);

                    // Update Redis cache
                    await updateGameCache(gameId);

                    // Update everyone that the tile is back on the table
                    io.to(gameId).emit('tileDiscarded', { userId: 'TABLE', tile: tileToReturn });

                    callback?.();
                } catch (e) {
                    console.error(e);
                    callback?.('Sunucu hatası');
                }
            });
        });

        socket.on('placeSets', async (setsOfIds: string[][], callback: (err?: string) => void) => {
            const member = await prisma.gameMember.findFirst({
                where: { userId },
                include: { game: true }
            });
            if (!member) return callback('Not in a game');
            const gameId = member.gameId;

            commandQueue.enqueue(gameId, async () => {
                try {
                    // Rate limiting
                    if (isRateLimited(socket.id, 'placeSets')) return callback('Too many placeSets requests');

                    const game = await prisma.game.findUnique({
                        where: { id: gameId },
                        include: { members: true }
                    }) as any;

                    const okeyTile = game.okeyTile as any;
                    const currentHand = (member.hand as any) || [];

                    const allTileIds = setsOfIds.flat();
                    const usedTiles = currentHand.filter((t: any) => allTileIds.includes(t.id));
                    if (usedTiles.length !== allTileIds.length) return callback('Some tiles not in hand');

                    // Convert IDs back to Tile objects for validation
                    const setsOfTiles = setsOfIds.map(ids =>
                        ids.map(id => currentHand.find((t: any) => t.id === id)) as Tile[]
                    );

                    const result = calculateMultipleSetsScore(setsOfTiles, okeyTile);
                    if (!result.isValid) return callback('Geçersiz setler');

                    const currentOpenScore = (member as any).openScore || 0;
                    const newTotalScore = currentOpenScore + result.totalScore;

                    // 101 Rule: Must reach 101 to open first time
                    if (currentOpenScore === 0 && newTotalScore < 101) {
                        return callback(`Hala 101 sayısına ulaşamadınız: ${newTotalScore}`);
                    }

                    const updatedHand = currentHand.filter((t: any) => !allTileIds.includes(t.id));
                    const existingSets = ((member as any).openSets as any) || [];
                    const updatedOpenSets = [...existingSets, ...setsOfTiles];

                    await prisma.gameMember.update({
                        where: { id: member.id },
                        data: {
                            hand: updatedHand,
                            openSets: updatedOpenSets as any,
                            openScore: newTotalScore,
                            mustOpen: false
                        } as any
                    });

                    // Update Redis cache
                    await updateGameCache(gameId);

                    // IMPORTANT: Reset turn timer on every successful set placement 
                    // to give the player more time for complex moves.
                    turnStartTimes.set(gameId, Date.now());

                    // Emit event for each set placed or one big event
                    for (const set of setsOfTiles) {
                        const setRes = calculateSetScore(set, okeyTile);
                        io.to(gameId).emit('setPlaced', { userId, tiles: set, score: setRes.score });
                    }

                    callback();
                } catch (e) {
                    console.error(e);
                    callback('Server error');
                }
            });
        });

        socket.on('chatMessage', async (data: { text: string }, callback?: (err?: string) => void) => {
            const member = await prisma.gameMember.findFirst({
                where: { userId },
                include: { user: true }
            });
            if (!member) return callback?.('Not in a lobby');

            const msg = {
                user: member.user.name || member.user.email,
                text: data.text
            };
            io.to(member.gameId).emit('chatMessage', msg);
            callback?.();
        });

        socket.on('disconnect', () => {
            console.log(`Socket disconnected: ${socket.id}`);
        });
    });



    return io;
};
