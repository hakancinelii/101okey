// src/socket/index.ts
import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { PrismaClient, GameStatus, MoveType } from '@prisma/client';
import { verifyToken } from '../middleware/auth';
import { generateTilePool, shuffle, distributeTiles, calculateSetScore, calculateMultipleSetsScore, calculateHandPenalty, canAddTileToSet } from '../game/logic';
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
        cors: {
            origin: (origin, callback) => {
                // Allow all origins to mirror our Express CORS logic
                callback(null, true);
            },
            methods: ['GET', 'POST'],
            credentials: true
        },
    });

    async function handleGameFinish(gameId: string, reason: string, winnerId?: string) {
        if (gameFinishLock.get(gameId)) return;
        gameFinishLock.set(gameId, true);
        try {
            const game = await prisma.game.findUnique({
                where: { id: gameId },
                include: { members: true }
            }) as any;

            if (!game || game.status === 'FINISHED' || game.status === 'PENDING') {
                gameFinishLock.delete(gameId);
                return;
            }

            const isFinalRound = game.currentRound >= game.maxRounds;
            const okeyTile = game.okeyTile as any;
            const isOkeyFinish = reason === 'OKEY_BITTI';
            const updates = [];

            for (const m of game.members) {
                let penalty = 0;
                if (m.userId === winnerId) {
                    penalty = 0; // Finisher gets 0 in 101? (Optional: -101 if standard rule)
                } else {
                    const hand = (m.hand as any) || [];
                    penalty = calculateHandPenalty(hand, okeyTile, m.openScore > 0);
                    if (isOkeyFinish) penalty *= 2; // Double penalty for Okey finish
                }

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

                const members = game.members;
                const currentMember = members.find(m => m.seat === game.turnIndex);
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

                // AI-like discard for force move: discard the last tile (usually toughest to fit)
                const discardedTile = currentHand.pop();

                // Robust next turn calculation
                const currIdx = members.findIndex(m => m.seat === game.turnIndex);
                const nextMember = members[(currIdx + 1) % members.length];
                const nextTurn = nextMember.seat;

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
                        where: { id: nextMember.id },
                        data: { hasDrawn: false, mustOpen: false } as any
                    })
                ]);

                await updateGameCache(gameId);
                io.to(gameId).emit('poolUpdate', { deckCount: pool.length });
                io.to(gameId).emit('tileDiscarded', { userId: currentMember.userId, tile: discardedTile });
                io.to(gameId).emit('turnUpdate', { turnIndex: nextTurn });
                console.log(`[ForceMove] Game ${gameId}: Seat ${currentMember.seat} -> ${nextTurn}. Discarded: ${discardedTile?.color}${discardedTile?.number}`);
                turnStartTimes.set(gameId, Date.now());
                setTimeout(() => checkAndProcessBotTurn(gameId), 3000);
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

                const members = game.members;
                const currentMember = members.find(m => m.seat === game.turnIndex);
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

                // Bot Draw
                const drawnTile = pool.shift();
                currentHand.push(drawnTile);
                const okeyTile = game.okeyTile as any;

                // Bot Brain: Try to find and place sets (Greedy)
                const setsFound: Tile[][] = [];
                const jokerNumber = (okeyTile.number % 13) + 1;

                // 1. Group same numbers
                const byNum: { [k: number]: Tile[] } = {};
                currentHand.forEach((t: Tile) => {
                    const isOkey = (t.color === okeyTile.color && t.number === jokerNumber) || t.isJoker;
                    if (isOkey) return; // skip okey for grouping
                    if (!byNum[t.number]) byNum[t.number] = [];
                    byNum[t.number].push(t);
                });
                Object.values(byNum).forEach(grp => {
                    if (grp.length >= 3) {
                        const uniqueColors = new Set(grp.map(t => t.color));
                        if (uniqueColors.size === grp.length) setsFound.push(grp);
                    }
                });

                // 2. Simple Sequence Finder
                const byColor: { [k: string]: Tile[] } = {};
                currentHand.forEach((t: Tile) => {
                    const isOkey = (t.color === okeyTile.color && t.number === jokerNumber) || t.isJoker;
                    if (isOkey) return;
                    if (!byColor[t.color]) byColor[t.color] = [];
                    byColor[t.color].push(t);
                });
                Object.values(byColor).forEach(tiles => {
                    const sorted = [...tiles].sort((a, b) => a.number - b.number);
                    let currentSeq: Tile[] = [];
                    for (let i = 0; i < sorted.length; i++) {
                        if (currentSeq.length === 0) currentSeq.push(sorted[i]);
                        else if (sorted[i].number === sorted[i - 1].number + 1) currentSeq.push(sorted[i]);
                        else {
                            if (currentSeq.length >= 3) setsFound.push([...currentSeq]);
                            currentSeq = [sorted[i]];
                        }
                    }
                    if (currentSeq.length >= 3) setsFound.push(currentSeq);
                });

                // If bot hasn't opened, check 101 rule
                const newSetsScore = setsFound.reduce((acc, s) => acc + calculateSetScore(s, okeyTile).score, 0);
                const hasAlreadyOpened = (currentMember.openScore || 0) > 0;
                const canOpenNow = newSetsScore >= 101;

                if (hasAlreadyOpened || canOpenNow) {
                    const alreadyUsedIds = new Set();
                    const validSetsToPlace = [];
                    let totalPlacingScore = 0;

                    for (const s of setsFound) {
                        if (s.every(t => !alreadyUsedIds.has(t.id))) {
                            validSetsToPlace.push(s);
                            s.forEach(t => alreadyUsedIds.add(t.id));
                            totalPlacingScore += calculateSetScore(s, okeyTile).score;
                        }
                    }

                    if (validSetsToPlace.length > 0) {
                        const allPlacedIds = new Set(validSetsToPlace.flat().map(t => t.id));
                        const remainingHand = currentHand.filter((t: Tile) => !allPlacedIds.has(t.id));
                        const existingSets = (currentMember.openSets as any) || [];

                        await prisma.gameMember.update({
                            where: { id: currentMember.id },
                            data: {
                                hand: remainingHand,
                                openSets: [...existingSets, ...validSetsToPlace] as any,
                                openScore: { increment: totalPlacingScore }
                            } as any
                        });

                        io.to(gameId).emit('setPlaced', {
                            userId: currentMember.userId,
                            tiles: validSetsToPlace.flat(),
                            score: totalPlacingScore
                        });

                        currentHand.length = 0;
                        currentHand.push(...remainingHand);
                    }
                }

                // Bot Stoning (Taş İşleme): Add stones to ANY player's sets if bot has opened
                if ((currentMember.openScore || 0) > 0 || newSetsScore >= 101) {
                    for (const target of game.members) {
                        if (!target.openSets || (target.openSets as any[]).length === 0) continue;
                        const tSets = [...(target.openSets as any[])];
                        let setsModified = false;

                        for (let sIdx = 0; sIdx < tSets.length; sIdx++) {
                            for (let hIdx = currentHand.length - 1; hIdx >= 0; hIdx--) {
                                const tile = currentHand[hIdx];
                                const isOkey = (tile.color === okeyTile.color && tile.number === jokerNumber) || tile.isJoker;
                                if (isOkey) continue;

                                const validation = canAddTileToSet(tSets[sIdx], tile, okeyTile);
                                if (validation.isValid) {
                                    tSets[sIdx] = validation.newSet;
                                    currentHand.splice(hIdx, 1);
                                    setsModified = true;
                                    io.to(gameId).emit('tileAddedToSet', {
                                        userId: currentMember.userId,
                                        targetUserId: target.userId,
                                        setIndex: sIdx,
                                        tile: tile
                                    });
                                }
                            }
                        }
                        if (setsModified) {
                            await prisma.gameMember.update({
                                where: { id: target.id },
                                data: { openSets: tSets as any } as any
                            });
                        }
                    }
                }

                // Bot Discard
                let discardIndex = 0;
                if (currentHand.length > 1) {
                    const jokerNumber = (okeyTile.number % 13) + 1;
                    const nonOkeyIdx = currentHand.findIndex((t: Tile) => !(t.color === okeyTile.color && t.number === jokerNumber));
                    if (nonOkeyIdx !== -1) discardIndex = nonOkeyIdx;
                }
                const discardedTile = currentHand[discardIndex];
                currentHand.splice(discardIndex, 1);

                if (currentHand.length === 0) {
                    const jokerNumber = (okeyTile.number % 13) + 1;
                    const isOkeyFinish = (discardedTile.color === okeyTile.color && discardedTile.number === jokerNumber) || discardedTile.isJoker;

                    await prisma.gameMember.update({
                        where: { id: currentMember.id },
                        data: { hand: [], hasDrawn: false, mustOpen: false } as any
                    });
                    io.to(gameId).emit('tileDiscarded', { userId: currentMember.userId, tile: discardedTile });
                    await handleGameFinish(gameId, isOkeyFinish ? 'OKEY_BITTI' : 'NORMAL_BITTI', currentMember.userId);
                    botProcessingLock.delete(gameId);
                    return;
                }

                // Next turn
                const currIdx = members.findIndex(m => m.seat === game.turnIndex);
                const nextMember = members[(currIdx + 1) % members.length];
                const nextTurn = nextMember.seat;

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
                        where: { id: nextMember.id },
                        data: { hasDrawn: false, mustOpen: false } as any
                    })
                ]);

                io.to(gameId).emit('poolUpdate', { deckCount: pool.length });
                io.to(gameId).emit('tileDiscarded', { userId: currentMember.userId, tile: discardedTile });
                io.to(gameId).emit('turnUpdate', { turnIndex: nextTurn });

                turnStartTimes.set(gameId, Date.now());
                botProcessingLock.delete(gameId);

                if (nextMember && nextMember.isBot) {
                    setTimeout(() => checkAndProcessBotTurn(gameId), 4000 + Math.random() * 2000);
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
                include: { members: { orderBy: { seat: 'asc' } } }
            });
            for (const game of activeGames) {
                const startTime = turnStartTimes.get(game.id);
                if (startTime) {
                    const elapsed = Date.now() - startTime;
                    const config = (game.config as any) || {};
                    const turnTimeout = (config.turnTime || 120) * 1000;

                    if (elapsed > turnTimeout) {
                        console.log(`[Supervisor] Timeout for game ${game.id}. Forcing move.`);
                        forceAutoMove(game.id).catch(e => console.error(e));
                    } else {
                        const currentMember = game.members.find(m => m.seat === game.turnIndex);
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
                include: { user: true },
                orderBy: { seat: 'asc' }
            });
            const game = await prisma.game.findUnique({ where: { id: lobbyId } });

            const memberList = members.map(m => ({
                id: m.userId,
                userId: m.userId,
                name: m.isBot ? `🤖 ${m.user.name}` : m.user.name || m.user.email,
                ready: m.isReady,
                isBot: m.isBot,
                seat: m.seat,
                host: m.userId === game?.hostId
            }));

            const settings = (game?.config as any) || {
                maxRounds: game?.maxRounds || 3,
                turnTime: 80,
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
                    const membersSorted = gameAfterJoin.members.sort((a, b) => a.seat - b.seat);
                    const playerList = membersSorted.map((m: any) => ({
                        userId: m.userId,
                        name: m.isBot ? `🤖 ${m.user?.name}` : m.user?.name || m.user?.email || 'Player',
                        seat: m.seat,
                        openScore: m.openScore || 0,
                        openSets: m.openSets || [],
                        penaltyScore: m.penaltyScore || 0
                    }));

                    const member = membersSorted.find(m => m.userId === userId);
                    socket.emit('gameStarted', {
                        gameId: lobbyId,
                        hand: (member as any)?.hand || [],
                        okeyTile: gameAfterJoin.okeyTile as any,
                        deckCount: (gameAfterJoin.tilePool as any)?.length || 0,
                        turnIndex: gameAfterJoin.turnIndex,
                        members: playerList,
                        hasDrawn: (member as any)?.hasDrawn || false,
                        mustOpen: (member as any)?.mustOpen || false
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
                    prisma.game.updateMany({
                        where: { hostId: userId, status: 'ACTIVE', id: { not: lobbyId } },
                        data: { status: 'FINISHED' }
                    }),
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
            const firstMemberRecord = members[0];
            const firstSeat = firstMemberRecord.seat;

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
                        turnIndex: firstSeat,
                        currentRound: roundNumber,
                        lastDiscard: null
                    } as any
                }),
                ...members.map((m, idx) =>
                    prisma.gameMember.update({
                        where: { id: m.id },
                        data: {
                            hand: hands[idx] as any,
                            hasDrawn: idx === 0, // First player in sorted list gets 22 tiles
                            openScore: 0,
                            openSets: [] as any,
                            mustOpen: false,
                            penaltyScore: 0,
                            isReady: false
                        } as any
                    })
                )
            ]);

            // Sync to Redis
            await updateGameCache(gameId);
            turnStartTimes.set(gameId, Date.now());
            botProcessingLock.delete(gameId);

            const membersList = members.map((m) => ({
                userId: m.userId,
                name: m.isBot ? `🤖 ${m.user?.name}` : m.user?.name || m.user?.email || 'Player',
                seat: m.seat,
                openScore: 0,
                openSets: [],
                penaltyScore: 0
            }));

            // Emit to each socket in the room with their private hand
            const sockets = await io.in(gameId).fetchSockets();
            sockets.forEach((s) => {
                const sUserId = (s as any).user?.userId;
                const m = members.find(mem => mem.userId === sUserId);
                if (m) {
                    const mIdx = members.indexOf(m);
                    s.emit('gameStarted', {
                        gameId,
                        hand: hands[mIdx],
                        okeyTile: okeyTile as any,
                        deckCount: remainingPool.length,
                        turnIndex: firstSeat,
                        members: membersList,
                        currentRound: roundNumber,
                        hasDrawn: mIdx === 0
                    });
                }
            });

            // If first player is bot, trigger bot logic
            const firstMember = members.find(m => m.seat === firstSeat);
            if (firstMember?.isBot) {
                setTimeout(() => checkAndProcessBotTurn(gameId), 4000);
            }
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
                        include: { members: { include: { user: true }, orderBy: { seat: 'asc' } } }
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
                (socket as any).activeGameId = gameId;

                const playerList = game.members.map((m: any) => ({
                    userId: m.userId,
                    name: m.user?.name || m.user?.email || (m.isBot ? 'Bot' : 'Player'),
                    seat: m.seat,
                    openSets: m.openSets || [],
                    openScore: m.openScore || 0,
                    penaltyScore: m.penaltyScore || 0
                }));

                const startTime = turnStartTimes.get(gameId);
                const turnTimeout = ((game.config as any)?.turnTime || 120) * 1000;
                const remainingTime = startTime ? Math.max(0, turnTimeout - (Date.now() - startTime)) : turnTimeout;

                socket.emit('gameState', {
                    hand: member.hand as any,
                    board: [],
                    deckCount: (game.tilePool as any)?.length || 0,
                    okeyTile: game.okeyTile as any,
                    turnIndex: game.turnIndex,
                    lastDiscard: game.lastDiscard as any,
                    members: playerList,
                    hasDrawn: member.hasDrawn,
                    mustOpen: member.mustOpen,
                    remainingTime: Math.floor(remainingTime / 1000)
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
            const activeGameId = (socket as any).activeGameId;
            if (!activeGameId) return callback?.(undefined, 'Lütfen önce oyuna katılın');

            const memberRecord = await prisma.gameMember.findFirst({
                where: { userId, gameId: activeGameId, game: { status: 'ACTIVE' } },
                include: { game: true }
            });
            if (!memberRecord) return callback?.(undefined, 'Aktif oyun bulunamadı');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    if (isRateLimited(socket.id, 'drawTile')) return callback?.(undefined, 'Çok fazla istek');

                    const game = await prisma.game.findUnique({
                        where: { id: activeGameId },
                        include: { members: { include: { user: true }, orderBy: { seat: 'asc' } } }
                    }) as any;

                    if (!game || game.status !== 'ACTIVE') return callback?.(undefined, 'Oyun aktif değil');

                    const member = game.members.find((m: any) => m.userId === userId);
                    if (!member) return callback?.(undefined, 'Oyuncu verisi hatası');

                    // Turn validation by seat
                    if (game.turnIndex !== member.seat) {
                        console.log(`[TurnMismatch] drawTile: gameId=${activeGameId}, user=${userId}, turn=${game.turnIndex}, seat=${member.seat}`);
                        return callback?.(undefined, 'Sıra sizde değil');
                    }

                    const pool = (game.tilePool as any) as any[];
                    if (!pool || pool.length === 0) return callback?.(undefined, 'Deste bitti');
                    if (member.hasDrawn) return callback?.(undefined, 'Zaten taş çektiniz');

                    const drawnTile = pool.shift();
                    const updatedHand = [...((member.hand as any) || []), drawnTile];

                    await prisma.$transaction([
                        prisma.game.update({ where: { id: activeGameId }, data: { tilePool: pool } as any }),
                        prisma.gameMember.update({ where: { id: member.id }, data: { hand: updatedHand, hasDrawn: true } as any })
                    ]);

                    await updateGameCache(activeGameId);
                    io.to(activeGameId).emit('poolUpdate', { deckCount: pool.length });
                    turnStartTimes.set(activeGameId, Date.now());

                    callback(drawnTile);
                } catch (e) {
                    console.error(e);
                    callback?.(undefined, 'Sunucu hatası');
                }
            });
        });

        socket.on('discardTile', async (tileId: string, callback?: (err?: string) => void) => {
            const activeGameId = (socket as any).activeGameId;
            if (!activeGameId) return callback?.('Lütfen önce oyuna katılın');

            const memberRecord = await prisma.gameMember.findFirst({
                where: { userId, gameId: activeGameId, game: { status: 'ACTIVE' } },
                include: { game: true }
            });
            if (!memberRecord) return callback?.('Aktif oyun bulunamadı');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    if (isRateLimited(socket.id, 'discardTile')) return callback?.('Çok fazla istek');

                    const game = await prisma.game.findUnique({
                        where: { id: activeGameId },
                        include: { members: { include: { user: true }, orderBy: { seat: 'asc' } } }
                    }) as any;

                    if (!game || game.status !== 'ACTIVE') return callback?.('Oyun aktif değil');

                    const member = game.members.find((m: any) => m.userId === userId);
                    if (!member) return callback?.('Oyuncu verisi hatası');

                    if (game.turnIndex !== member.seat) {
                        console.log(`[TurnMismatch] discardTile: gameId=${activeGameId}, user=${userId}, turn=${game.turnIndex}, seat=${member.seat}`);
                        return callback?.('Sıra sizde değil');
                    }

                    if (!member.hasDrawn) return callback?.('Önce taş çekmelisiniz');
                    if (member.mustOpen) return callback?.('Yan taş aldığınız için yere per açmak zorundasınız');

                    const currentHand = (member.hand as any) || [];
                    const discardedTile = currentHand.find((t: any) => t.id === tileId);
                    if (!discardedTile) return callback?.('Taş elinizde bulunamadı');
                    const updatedHand = currentHand.filter((t: any) => t.id !== tileId);

                    if (updatedHand.length === 0) {
                        const okeyTile = game.okeyTile as any;
                        const jokerNumber = (okeyTile.number % 13) + 1;
                        const isOkeyFinish = (discardedTile.color === okeyTile.color && discardedTile.number === jokerNumber) || discardedTile.isJoker;

                        await prisma.gameMember.update({
                            where: { id: member.id },
                            data: { hand: [], hasDrawn: false, mustOpen: false } as any
                        });
                        io.to(activeGameId).emit('tileDiscarded', { userId, tile: discardedTile });

                        await handleGameFinish(activeGameId, isOkeyFinish ? 'OKEY_BITTI' : 'NORMAL_BITTI', userId);
                        return callback?.();
                    }

                    // Robust next turn calculation
                    const currIdx = game.members.findIndex((m: any) => m.seat === game.turnIndex);
                    const nextMember = game.members[(currIdx + 1) % game.members.length];
                    const nextTurn = nextMember.seat;

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
                            where: { id: nextMember.id },
                            data: { hasDrawn: false, mustOpen: false } as any
                        })
                    ]);

                    io.to(activeGameId).emit('tileDiscarded', { userId, tile: discardedTile });
                    io.to(activeGameId).emit('turnUpdate', { turnIndex: nextTurn });

                    turnStartTimes.set(activeGameId, Date.now());

                    setTimeout(() => checkAndProcessBotTurn(activeGameId), 4000 + Math.random() * 2000);

                    await updateGameCache(activeGameId);
                    callback?.();
                } catch (e) {
                    console.error(e);
                    callback?.('Sunucu hatası');
                }
            });
        });

        socket.on('drawDiscard', async (callback: (tile?: any, err?: string) => void) => {
            const activeGameId = (socket as any).activeGameId;
            if (!activeGameId) return callback?.(undefined, 'Lütfen önce oyuna katılın');

            const memberRecord = await prisma.gameMember.findFirst({
                where: { userId, gameId: activeGameId, game: { status: 'ACTIVE' } },
                include: { game: true }
            });
            if (!memberRecord) return callback?.(undefined, 'Aktif oyun bulunamadı');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    if (isRateLimited(socket.id, 'drawDiscard')) return callback?.(undefined, 'Çok fazla istek');

                    const game = await prisma.game.findUnique({
                        where: { id: activeGameId },
                        include: { members: { include: { user: true }, orderBy: { seat: 'asc' } } }
                    }) as any;

                    if (!game || !game.lastDiscard) return callback?.(undefined, 'Alınacak taş yok');

                    const member = game.members.find((m: any) => m.userId === userId);
                    if (!member) return callback?.(undefined, 'Oyuncu verisi hatası');

                    if (game.turnIndex !== member.seat) {
                        return callback?.(undefined, 'Sıra sizde değil');
                    }

                    if (member.hasDrawn) return callback?.(undefined, 'Zaten taş çektiniz');

                    const currentHand = (member.hand as any) || [];
                    const drawnTile = game.lastDiscard;
                    const updatedHand = [...currentHand, drawnTile];

                    await prisma.$transaction([
                        prisma.gameMember.update({ where: { id: member.id }, data: { hand: updatedHand, hasDrawn: true, mustOpen: true } as any }),
                        prisma.game.update({ where: { id: activeGameId }, data: { lastDiscard: null } as any })
                    ]);

                    await updateGameCache(activeGameId);
                    turnStartTimes.set(activeGameId, Date.now());

                    io.to(activeGameId).emit('discardDrawn', { userId, tile: drawnTile });
                    callback(drawnTile);
                } catch (e) {
                    console.error(e);
                    callback?.(undefined, 'Sunucu hatası');
                }
            });
        });

        socket.on('undoDrawDiscard', async (tileId: string, callback?: (err?: string) => void) => {
            const activeGameId = (socket as any).activeGameId;
            if (!activeGameId) return callback?.('Lütfen önce oyuna katılın');

            const memberRecord = await prisma.gameMember.findFirst({
                where: { userId, gameId: activeGameId, game: { status: 'ACTIVE' } },
                include: { game: true }
            });
            if (!memberRecord) return callback?.('Aktif oyun bulunamadı');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    const member = await prisma.gameMember.findUnique({ where: { id: memberRecord.id } });
                    if (!member || !member.mustOpen) return callback?.('Geri verilecek taş bulunamadı');

                    if (isRateLimited(socket.id, 'undoDrawDiscard')) return callback?.('Çok fazla işlem yapıyorsunuz');

                    const currentHand = (member.hand as any) || [];
                    const tileToReturn = currentHand.find((t: any) => t.id === tileId);
                    if (!tileToReturn) return callback?.('Taş listenizde bulunamadı');

                    const updatedHand = currentHand.filter((t: any) => t.id !== tileId);
                    const newPenalty = (member.penaltyScore || 0) + 101;

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
                            where: { id: activeGameId },
                            data: { lastDiscard: tileToReturn } as any
                        })
                    ]);

                    await updateGameCache(activeGameId);
                    io.to(activeGameId).emit('tileDiscarded', { userId: 'TABLE', tile: tileToReturn });
                    callback?.();
                } catch (e) {
                    console.error(e);
                    callback?.('Sunucu hatası');
                }
            });
        });

        socket.on('placeSets', async (setsOfIds: string[][], callback: (err?: string) => void) => {
            const activeGameId = (socket as any).activeGameId;
            if (!activeGameId) return callback('Lütfen önce oyuna katılın');

            const memberRecord = await prisma.gameMember.findFirst({
                where: { userId, gameId: activeGameId, game: { status: 'ACTIVE' } },
                include: { game: true }
            });
            if (!memberRecord) return callback('Aktif oyun bulunamadı');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    if (isRateLimited(socket.id, 'placeSets')) return callback('Çok fazla işlem yapıyorsunuz');

                    const game = await prisma.game.findUnique({
                        where: { id: activeGameId },
                        include: { members: true }
                    }) as any;

                    const member = game.members.find((m: any) => m.id === memberRecord.id);
                    if (!member) return callback('Üye bulunamadı');

                    const okeyTile = game.okeyTile as any;
                    const currentHand = (member.hand as any) || [];

                    const allTileIds = setsOfIds.flat();
                    const uniqueIds = new Set(allTileIds);
                    if (uniqueIds.size !== allTileIds.length) {
                        return callback('Aynı taşı birden fazla kez kullanamazsınız.');
                    }

                    const missingIds = allTileIds.filter(id => !currentHand.find((t: any) => t.id === id));
                    if (missingIds.length > 0) {
                        console.log(`[PlaceSetsError] Game ${activeGameId}, User ${userId} missing IDs: ${missingIds.join(', ')}`);
                        return callback('Bazı taşlar elinizde değil (Senkronizasyon hatası). Lütfen sayfayı yenileyip tekrar deneyin.');
                    }

                    // Convert IDs back to Tile objects for validation
                    const setsOfTiles: Tile[][] = [];
                    for (const ids of setsOfIds) {
                        const tileSet: Tile[] = [];
                        for (const tid of ids) {
                            const found = currentHand.find((t: any) => t.id === tid);
                            if (!found) {
                                console.log(`[PlaceSetsError] Tile ID ${tid} not found in Hand of user ${userId}`);
                                return callback(`Bazı taşlar elinizde değil (ID: ${tid}). Lütfen sayfayı yenileyiniz.`);
                            }
                            tileSet.push(found);
                        }
                        setsOfTiles.push(tileSet);
                    }

                    const result = calculateMultipleSetsScore(setsOfTiles, okeyTile);

                    if (!result.isValid) {
                        let errorMsg = 'Geçersiz set yapısı. Lütfen perlerinizi kontrol edin.';
                        if (result.reason === 'GROUP_DUPLICATE_COLORS') {
                            errorMsg = 'Hata: Bir grupta aynı renkten iki taş bulunamaz (Örn: İki tane Siyah 3 olamaz).';
                        } else if (result.reason === 'GROUP_DIFFERENT_NUMBERS') {
                            errorMsg = 'Hata: Gruplar aynı sayılardan oluşmalıdır.';
                        } else if (result.reason === 'SET_TOO_SHORT') {
                            errorMsg = 'Hata: Perler en az 3 taştan oluşmalıdır.';
                        }
                        return callback(errorMsg);
                    }

                    const currentOpenScore = (member as any).openScore || 0;
                    const newTotalScore = result.totalScore;

                    // 101 Rule: Must reach 101 to open first time, unless it's a Pair (Çift) hand
                    if (currentOpenScore === 0 && newTotalScore < 101 && !result.isPairHand) {
                        return callback(`Toplam puanınız (${newTotalScore}) henüz 101 barajına ulaşmadı. Seri veya gruplarınızı büyütmelisiniz. (Alternatif: En az 5 çift dizerek de açabilirsiniz).`);
                    }

                    if (result.isPairHand && setsOfTiles.length < 5) {
                        return callback('Çift ile açmak için en az 5 çiftiniz olmalıdır.');
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

                    await updateGameCache(activeGameId);
                    turnStartTimes.set(activeGameId, Date.now());

                    for (const set of setsOfTiles) {
                        const setRes = calculateSetScore(set, okeyTile);
                        io.to(activeGameId).emit('setPlaced', { userId, tiles: set, score: setRes.score });
                    }

                    callback();
                } catch (e) {
                    console.error(e);
                    callback('Sunucu hatası');
                }
            });
        });

        socket.on('addToSet', async (data: { targetUserId: string, setIndex: number, tileId: string }, callback: (err?: string) => void) => {
            const activeGameId = (socket as any).activeGameId;
            if (!activeGameId) return callback('Lütfen önce oyuna katılın');

            commandQueue.enqueue(activeGameId, async () => {
                try {
                    const game = await prisma.game.findUnique({
                        where: { id: activeGameId },
                        include: { members: true }
                    }) as any;

                    const myMember = game.members.find((m: any) => m.userId === userId);
                    if (!myMember) return callback('Üye bulunamadı');
                    if (myMember.openScore === 0) return callback('Taş işleyebilmek için önce elinizi açmalısınız.');

                    if (game.turnIndex !== myMember.seat) return callback('Sıra sizde değil');
                    if (!myMember.hasDrawn) return callback('Önce taş çekmelisiniz');

                    const targetMember = game.members.find((m: any) => m.userId === data.targetUserId);
                    if (!targetMember || !targetMember.openSets) return callback('Geçersiz hedef oyuncu');

                    const openSets = [...(targetMember.openSets as any[])];
                    if (data.setIndex < 0 || data.setIndex >= openSets.length) return callback('Geçersiz set indeksi');

                    const currentHand = (myMember.hand as any[]) || [];
                    const tileToAdd = currentHand.find((t: any) => t.id === data.tileId);
                    if (!tileToAdd) return callback('Taş elinizde bulunamadı');

                    const validation = canAddTileToSet(openSets[data.setIndex], tileToAdd, game.okeyTile as any);
                    if (!validation.isValid) return callback('Bu taş bu sete eklenemez');

                    // Update data
                    const updatedHand = currentHand.filter((t: any) => t.id !== data.tileId);
                    openSets[data.setIndex] = validation.newSet;

                    await prisma.$transaction([
                        prisma.gameMember.update({
                            where: { id: myMember.id },
                            data: { hand: updatedHand } as any
                        }),
                        prisma.gameMember.update({
                            where: { id: targetMember.id },
                            data: { openSets: openSets as any } as any
                        })
                    ]);

                    await updateGameCache(activeGameId);
                    io.to(activeGameId).emit('tileAddedToSet', {
                        userId,
                        targetUserId: data.targetUserId,
                        setIndex: data.setIndex,
                        tile: tileToAdd
                    });

                    callback();
                } catch (e) {
                    console.error(e);
                    callback('Sunucu hatası');
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
