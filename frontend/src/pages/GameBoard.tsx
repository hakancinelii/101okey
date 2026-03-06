import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { io, Socket } from 'socket.io-client';
import { BACKEND_URL } from '../config';

// Types for tiles and chat messages
interface ChatMessage {
    user: string;
    text: string;
}

interface Tile {
    id: string; // unique identifier for UI purposes
    color: string; // 'red', 'blue', 'black', 'yellow'
    number: number; // 1-13
    isJoker?: boolean;
    isFakeJoker?: boolean;
}

interface Member {
    userId: string;
    name: string;
    seat: number;
    openScore?: number;
    openSets?: Tile[][];
    penaltyScore?: number;
    totalPenaltyScore?: number;
    isBot?: boolean;
    host?: boolean;
}


const GameBoard: React.FC = () => {
    const { t } = useTranslation();
    const { gameId } = useParams<{ gameId: string }>();
    const navigate = useNavigate();
    const location = useLocation();

    // Initial hand from navigation state (sent from Lobby)
    const [hand, setHand] = useState<Tile[]>(location.state?.initialHand || []);
    const [deckCount, setDeckCount] = useState<number>(location.state?.deckCount || 0);
    const [okeyTile, setOkeyTile] = useState<Tile | null>(location.state?.okeyTile || null);
    const [turnIndex, setTurnIndex] = useState<number>(location.state?.turnIndex || 0);
    const [lastDiscard, setLastDiscard] = useState<Tile | null>(location.state?.lastDiscard || null);
    const [members, setMembers] = useState<Member[]>(location.state?.members || []);
    const [timeRemaining, setTimeRemaining] = useState(60);
    const [selectedTileIds, setSelectedTileIds] = useState<Set<string>>(new Set());
    const [pendingSets, setPendingSets] = useState<Tile[][]>([]);
    const socketRef = useRef<Socket | null>(null);

    // Draggable state
    const [rackSlots, setRackSlots] = useState<(Tile | null)[]>(new Array(44).fill(null));
    const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
    const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const dragStartRef = useRef({ x: 0, y: 0 }); // Fix stale closures
    const dragPosRef = useRef({ x: 0, y: 0 });   // Fix stale closures
    const [flippedTileIds, setFlippedTileIds] = useState<Set<string>>(new Set());
    const [chat, setChat] = useState<ChatMessage[]>([]);
    const [msgInput, setMsgInput] = useState('');
    const [showChat, setShowChat] = useState(false);
    const [mustOpen, setMustOpen] = useState(false);
    const [hasDrawn, setHasDrawn] = useState(false);
    const [lastDrawnTileId, setLastDrawnTileId] = useState<string | null>(null);
    const [discardHistory, setDiscardHistory] = useState<{ tile: Tile; userId: string }[]>([]);
    const [showFinishModal, setShowFinishModal] = useState(false);
    const [finishData, setFinishData] = useState<{ reason: string, members: Member[], currentRound?: number, maxRounds?: number, isFinal?: boolean } | null>(null);
    const [isGameEnded, setIsGameEnded] = useState(false);
    const [currentRound, setCurrentRound] = useState(1);
    const [maxRounds, setMaxRounds] = useState(3);
    const chatEndRef = useRef<HTMLDivElement>(null);

    // Audio Refs
    const drawAudio = useRef<HTMLAudioElement>(new Audio('/sounds/draw.mp3'));
    const discardAudio = useRef<HTMLAudioElement>(new Audio('/sounds/discard.mp3'));
    const moveAudio = useRef<HTMLAudioElement>(new Audio('/sounds/move.mp3'));
    const shuffleAudio = useRef<HTMLAudioElement>(new Audio('/sounds/shuffle.mp3'));

    const playSound = (audioRef: React.RefObject<HTMLAudioElement>) => {
        if (audioRef.current) {
            audioRef.current.currentTime = 0;
            audioRef.current.play().catch(() => { }); // Catch prevents issues with user interaction policy
        }
    };

    const token = localStorage.getItem('token') || '';

    // Decode token to get user name
    const getUserInfo = () => {
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return {
                userId: payload.userId || payload.sub,
                name: payload.email || payload.userId || 'User'
            };
        } catch {
            return { userId: '', name: 'User' };
        }
    };

    // Initialize socket connection
    useEffect(() => {
        const timer = setInterval(() => {
            setTimeRemaining(prev => (prev > 0 ? prev - 1 : 0));
        }, 1000);

        // Map hand to rack slots initially
        const newSlots = new Array(44).fill(null);
        hand.forEach((tile, i) => { if (i < 44) newSlots[i] = tile; });
        setRackSlots(newSlots);

        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        const socket = io(BACKEND_URL, {
            auth: { token },
            transports: ['polling', 'websocket'],
            reconnectionAttempts: 5,
            timeout: 10000
        });
        socketRef.current = socket;

        socket.on('connect_error', (err) => {
            console.error('Lobby Socket Connect Error:', err.message);
        });

        socket.on('connect', () => {
            if (gameId) socket.emit('joinGame', gameId, (err?: string) => {
                if (err) {
                    console.error('joinGame error', err);
                    navigate('/dashboard');
                }
            });
        });

        // Receive periodic game state or updates
        socket.on('gameState', (state: any) => {
            // Filter out tiles that are in pending sets to avoid duplication glitches
            const pendingIds = new Set(pendingSets.flat().map(t => t.id));
            const filteredHand = Array.isArray(state.hand) ? (state.hand as Tile[]).filter((t: Tile) => !pendingIds.has(t.id)) : [];
            setHand(filteredHand);

            // Sync rack slots with filtered hand
            setRackSlots(prev => {
                const next = [...prev];
                // Remove tiles no longer in hand
                next.forEach((slot, i) => {
                    if (slot && !filteredHand.find((t: Tile) => t.id === slot.id)) next[i] = null;
                });
                // Add new tiles
                filteredHand.forEach((tile: Tile) => {
                    if (!next.find(s => s?.id === tile.id)) {
                        const emptyIdx = next.indexOf(null);
                        if (emptyIdx !== -1) next[emptyIdx] = tile;
                    }
                });
                return next;
            });

            if (state.deckCount !== undefined) setDeckCount(state.deckCount);
            if (state.okeyTile) setOkeyTile(state.okeyTile);
            if (state.turnIndex !== undefined) {
                setTurnIndex(state.turnIndex);
                if (state.remainingTime !== undefined) {
                    setTimeRemaining(state.remainingTime);
                } else if (turnIndex !== state.turnIndex) {
                    setTimeRemaining(120);
                }
            }
            if (state.members) {
                const sortedMembers = [...state.members].sort((a: any, b: any) => a.seat - b.seat);
                setMembers(sortedMembers);
            }
            if (state.lastDiscard !== undefined) setLastDiscard(state.lastDiscard);

            // Sync drawing and state flags from server if provided
            if (state.hasDrawn !== undefined) setHasDrawn(state.hasDrawn);
            if (state.mustOpen !== undefined) setMustOpen(state.mustOpen);

            // Fallback sync drawing state: if turn is mine and I have 22 tiles, I must have drawn
            const myInfo = getUserInfo();
            if (state.turnIndex !== undefined && state.members) {
                const myMember = Array.isArray(state.members) ? state.members.find((m: any) => m.userId === myInfo.userId) : null;
                if (myMember && state.turnIndex === myMember.seat && state.hasDrawn === undefined) {
                    if (state.hand) {
                        setHasDrawn(state.hand.length > 21);
                    }
                }
            }
        });

        // Receiving gameStarted event in GameBoard in case of re-connect or late emit
        socket.on('gameStarted', (data: { hand: Tile[]; deckCount: number; okeyTile: Tile; turnIndex: number; members: Member[]; currentRound?: number; maxRounds?: number }) => {
            playSound(shuffleAudio);
            setIsGameEnded(false);
            setShowFinishModal(false);
            if (data.hand) {
                const pendingIds = new Set(pendingSets.flat().map(t => t.id));
                const filtered = data.hand.filter((t: Tile) => !pendingIds.has(t.id));
                setHand(filtered);
                setRackSlots(_prev => {
                    const next = new Array(44).fill(null);
                    filtered.forEach((tile: Tile, i: number) => { if (i < 44) next[i] = tile; });
                    return next;
                });
            }
            setDeckCount(data.deckCount);
            setOkeyTile(data.okeyTile);
            setTurnIndex(data.turnIndex);
            setTimeRemaining(120);
            if (data.members) {
                const sortedMembers = [...data.members].sort((a, b) => a.seat - b.seat);
                setMembers(sortedMembers);
            }
            if (data.currentRound) setCurrentRound(data.currentRound);
            if (data.maxRounds) setMaxRounds(data.maxRounds);

            // Sync state flags if provided
            if ((data as any).hasDrawn !== undefined) setHasDrawn((data as any).hasDrawn);
            if ((data as any).mustOpen !== undefined) setMustOpen((data as any).mustOpen);

            const myInfo = getUserInfo();
            const myMemberInData = Array.isArray(data.members) ? data.members.find((m: any) => m.userId === myInfo.userId) : null;
            if (myMemberInData && data.turnIndex === myMemberInData.seat && (data as any).hasDrawn === undefined) {
                if (data.hand) setHasDrawn(data.hand.length > 21);
            }
        });


        // Pool count updates
        socket.on('poolUpdate', (data: { deckCount: number }) => {
            setDeckCount(data.deckCount);
        });

        // Turn updates — reset hasDrawn when turn changes
        socket.on('turnUpdate', (data: { turnIndex: number }) => {
            setTurnIndex(data.turnIndex);
            setTimeRemaining(120);
            setHasDrawn(false);
            setLastDrawnTileId(null);
        });

        // Someone discarded a tile
        socket.on('tileDiscarded', (data: { userId: string, tile: Tile }) => {
            playSound(discardAudio);
            setLastDiscard(data.tile);
            setDiscardHistory(prev => [...prev.slice(-11), { tile: data.tile, userId: data.userId }]);
        });

        // Someone drew the discarded tile — remove top of history
        socket.on('discardDrawn', (_data: { userId: string, tile: Tile }) => {
            setLastDiscard(null);
            setDiscardHistory(prev => prev.slice(0, -1));
        });

        // Someone placed a set
        socket.on('setPlaced', (data: { userId: string, tiles: Tile[], score: number }) => {
            setMembers(prev => prev.map(m => {
                if (m.userId === data.userId) {
                    return {
                        ...m,
                        openScore: (m.openScore || 0) + data.score,
                        openSets: [...(m.openSets || []), data.tiles]
                    };
                }
                return m;
            }));
        });

        socket.on('tileAddedToSet', (data: { userId: string, targetUserId: string, setIndex: number, tile: Tile }) => {
            setMembers(prev => prev.map(m => {
                if (m.userId === data.targetUserId) {
                    const currentSets = (m.openSets as Tile[][]) || [];
                    const newSets = [...currentSets];
                    if (newSets[data.setIndex]) {
                        newSets[data.setIndex] = [...newSets[data.setIndex], data.tile];
                    }
                    return { ...m, openSets: newSets };
                }
                return m;
            }));
        });

        // Chat messages
        socket.on('chatMessage', (msg: ChatMessage) => {
            setChat((prev) => [...prev, msg]);
        });

        // Game Finished
        socket.on('gameFinished', (data: { reason: string, members: Member[] }) => {
            setFinishData(data);
            setIsGameEnded(true);
            // Optionally auto-show after 5 seconds if not clicked?
            // setTimeout(() => setShowFinishModal(true), 5000);
        });

        // Cleanup on unmount
        return () => {
            socket.disconnect();
        };
    }, [gameId, navigate, token]);

    useEffect(() => {
        if (showChat) {
            chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [chat, showChat]);

    // ----- Game actions -----------------------------------------------------
    const drawTile = async (targetSlotIdx?: number) => {
        if (!socketRef.current) return;
        if (hasDrawn) return; // prevent double-draw
        socketRef.current.emit('drawTile', (tile?: Tile, err?: string) => {
            if (err) { console.error('drawTile error', err); return; }
            if (tile) {
                playSound(drawAudio);
                setHand((prev) => [...prev, tile]);
                setHasDrawn(true);
                setLastDrawnTileId(tile.id);
                setRackSlots(prev => {
                    const next = [...prev];
                    const idx = (targetSlotIdx !== undefined && next[targetSlotIdx] === null) ? targetSlotIdx : next.indexOf(null);
                    if (idx !== -1) next[idx] = tile;
                    return next;
                });
                // Clear highlight after 3s
                setTimeout(() => setLastDrawnTileId(null), 3000);
            }
        });
    };

    const discardTile = async (tileId: string) => {
        if (!socketRef.current) return;
        socketRef.current.emit('discardTile', tileId, (err?: string) => {
            if (err) return alert(err);
            setHand((prev) => prev.filter((t) => t.id !== tileId));
            setRackSlots(prev => prev.map(s => s?.id === tileId ? null : s));
            setHasDrawn(false);
            setLastDrawnTileId(null);
        });
    };

    const drawDiscard = async (targetSlotIdx?: number) => {
        if (!socketRef.current || !lastDiscard) return;
        socketRef.current.emit('drawDiscard', (tile?: Tile, err?: string) => {
            if (err) return alert(err);
            if (tile) {
                playSound(drawAudio);
                setHand((prev) => [...prev, tile]);
                setRackSlots(prev => {
                    const next = [...prev];
                    const idx = (targetSlotIdx !== undefined && next[targetSlotIdx] === null) ? targetSlotIdx : next.indexOf(null);
                    if (idx !== -1) next[idx] = tile;
                    return next;
                });
                setLastDiscard(null);
                setMustOpen(true);
            }
        });
    };

    const undoDrawDiscard = async () => {
        if (!socketRef.current || !mustOpen) return;
        // In this simple logic, the last tile in hand is the one we picked
        const lastPickedTile = hand[hand.length - 1];
        if (!lastPickedTile) return;

        socketRef.current.emit('undoDrawDiscard', lastPickedTile.id, (err?: string) => {
            if (err) return alert(err);
            setHand(prev => prev.filter(t => t.id !== lastPickedTile.id));
            setRackSlots(prev => prev.map(s => s?.id === lastPickedTile.id ? null : s));
            setLastDiscard(lastPickedTile);
            setMustOpen(false);
            // Optionally update local penalty score (server will update anyway via events/state)
        });
    };

    const placeSets = async (sets: Tile[][]) => {
        if (!socketRef.current || sets.length === 0) return;

        // Optimistically clear pending sets to prevent double-submit synchronization errors
        const previousPending = [...pendingSets];
        setPendingSets([]);

        socketRef.current.emit('placeSets', sets.map(s => s.map(t => t.id)), (err?: string) => {
            if (err) {
                setPendingSets(previousPending);
                return alert(err);
            }
        });
    };

    const addGroup = () => {
        if (selectedTileIds.size < 2) return alert(t('selectAtLeast2'));

        // Get selected tiles IN THE ORDER THEY APPEAR ON THE RACK (preserving user manual arrangement)
        const tilesToGroup: Tile[] = [];
        rackSlots.forEach(slot => {
            if (slot && selectedTileIds.has(slot.id)) {
                tilesToGroup.push(slot);
            }
        });

        if (tilesToGroup.length < selectedTileIds.size) {
            // Fallback for edge cases where it's in hand but not in rack slots
            const missingIds = Array.from(selectedTileIds).filter(id => !tilesToGroup.some(t => t.id === id));
            missingIds.forEach(id => {
                const t = hand.find(h => h.id === id);
                if (t) tilesToGroup.push(t);
            });
        }

        if (tilesToGroup.length < selectedTileIds.size) {
            return alert('Bazı taşlar zaten gruplanmış veya elinizde değil.');
        }

        setPendingSets(prev => [...prev, tilesToGroup]);

        // Remove from hand AND rackSlots immediately
        const idsToRemove = new Set(tilesToGroup.map(t => t.id));
        setHand(prev => prev.filter(t => !idsToRemove.has(t.id)));
        setRackSlots(prev => prev.map(slot => (slot && idsToRemove.has(slot.id)) ? null : slot));

        setSelectedTileIds(new Set());
    };

    const sortSeri = () => {
        // 1. Identify sets (runs or groups)
        const tiles = [...hand];
        const sets: Tile[][] = [];
        const used = new Set<string>();

        // Sort for run detection: color then number
        const sortedForRuns = [...tiles].sort((a, b) => a.color.localeCompare(b.color) || a.number - b.number);

        // Find runs (same color, sequential)
        let currentRun: Tile[] = [];
        for (let i = 0; i < sortedForRuns.length; i++) {
            const t = sortedForRuns[i];
            if (currentRun.length === 0) {
                currentRun.push(t);
            } else {
                const last = currentRun[currentRun.length - 1];
                if (last.color === t.color && last.number + 1 === t.number) {
                    currentRun.push(t);
                } else if (last.color === t.color && last.number === t.number) {
                    // Duplicate - skip for now
                } else {
                    if (currentRun.length >= 3) {
                        sets.push([...currentRun]);
                        currentRun.forEach(rt => used.add(rt.id));
                    }
                    currentRun = [t];
                }
            }
        }
        if (currentRun.length >= 3) {
            sets.push([...currentRun]);
            currentRun.forEach(rt => used.add(rt.id));
        }

        // Find groups (same number, different colors) for the remaining tiles
        const remaining = tiles.filter(t => !used.has(t.id));
        const byNumber: Record<number, Tile[]> = {};
        remaining.forEach(t => {
            if (!byNumber[t.number]) byNumber[t.number] = [];
            byNumber[t.number].push(t);
        });

        Object.values(byNumber).forEach(group => {
            // Ensure unique colors in a group
            const uniqueColors: Tile[] = [];
            const seenColors = new Set();
            group.forEach(t => {
                if (!seenColors.has(t.color)) {
                    uniqueColors.push(t);
                    seenColors.add(t.color);
                }
            });
            if (uniqueColors.length >= 3) {
                sets.push(uniqueColors);
                uniqueColors.forEach(t => used.add(t.id));
            }
        });

        // Tiles not in any set
        const leftovers = tiles.filter(t => !used.has(t.id)).sort((a, b) => a.number - b.number);

        // 2. Place on rack with gaps
        const newSlots = new Array(44).fill(null);
        let cursor = 0;

        sets.forEach((set, _idx) => {
            // Check if set fits in current row (22 slots per row)
            const rowEnd = cursor <= 21 ? 21 : 43;
            if (cursor + set.length > rowEnd + 1 && cursor <= 21) {
                cursor = 22; // Jump to second row if it doesn't fit in first
            }

            set.forEach(t => {
                if (cursor < 44) newSlots[cursor++] = t;
            });
            cursor++; // Add gap
        });

        // Add leftovers
        if (cursor <= 21 && cursor + leftovers.length > 22) cursor = 22;
        leftovers.forEach(t => {
            if (cursor < 44) newSlots[cursor++] = t;
        });

        setRackSlots(newSlots);
    };

    const sortCift = () => {
        const tiles = [...hand];
        const pairs: Tile[][] = [];
        const used = new Set<string>();

        // Find pairs (exact same color and number)
        for (let i = 0; i < tiles.length; i++) {
            if (used.has(tiles[i].id)) continue;
            for (let j = i + 1; j < tiles.length; j++) {
                if (used.has(tiles[j].id)) continue;
                if (tiles[i].number === tiles[j].number && tiles[i].color === tiles[j].color) {
                    pairs.push([tiles[i], tiles[j]]);
                    used.add(tiles[i].id);
                    used.add(tiles[j].id);
                    break;
                }
            }
        }

        const leftovers = tiles.filter(t => !used.has(t.id)).sort((a, b) => a.number - b.number);

        const newSlots = new Array(44).fill(null);
        let cursor = 0;

        pairs.forEach(pair => {
            if (cursor % 22 > 20 && cursor < 22) cursor = 22; // Avoid splitting pair across rows
            pair.forEach(t => { if (cursor < 44) newSlots[cursor++] = t; });
            cursor++; // Gap
        });

        // Change row for leftovers if needed
        if (cursor <= 21 && cursor + leftovers.length > 22) cursor = 22;
        leftovers.forEach(t => {
            if (cursor < 44) newSlots[cursor++] = t;
        });

        setRackSlots(newSlots);
    };
    const sendMessage = (e: React.FormEvent) => {
        e.preventDefault();
        if (!msgInput.trim() || !socketRef.current) return;
        socketRef.current.emit('chatMessage', { text: msgInput });
        setMsgInput('');
    };

    // ----- Drag logic --------------------------------------------------------
    const handleDragStart = (e: React.PointerEvent, idx: number) => {
        if (!rackSlots[idx]) return;
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);

        const start = { x: e.clientX, y: e.clientY };
        setDraggingIdx(idx);
        setDragStart(start);
        dragStartRef.current = start;

        setDragPos({ x: 0, y: 0 });
        dragPosRef.current = { x: 0, y: 0 };
    };

    const handlePointerMove = (e: PointerEvent) => {
        if (draggingIdx === null) return;
        const pos = {
            x: e.clientX - dragStartRef.current.x,
            y: e.clientY - dragStartRef.current.y
        };
        dragPosRef.current = pos;
        setDragPos(pos);
    };

    const handlePointerUp = async (e: PointerEvent) => {
        if (draggingIdx === null) return;

        // Check drop target via elementFromPoint
        const element = document.elementFromPoint(e.clientX, e.clientY);
        const slotIdxAttr = element?.getAttribute('data-slot-idx') || element?.closest('[data-slot-idx]')?.getAttribute('data-slot-idx');
        const targetSlotIdx = (slotIdxAttr !== null && slotIdxAttr !== undefined) ? parseInt(slotIdxAttr) : undefined;
        const isDiscard = element?.id === 'discard-zone' || element?.closest('#discard-zone');
        const isRack = element?.closest('.bg-isteka');

        // Use Ref values to avoid stale closure issues during fast drags
        const currentDragPos = dragPosRef.current;
        const flingUp = currentDragPos.y < -100;
        const isFlingDiscard = flingUp;

        if (draggingIdx >= 0) {
            // Dragging tile FROM rack
            const tile = rackSlots[draggingIdx];
            if (!tile) {
                setDraggingIdx(null);
                return;
            }

            if (isDiscard || isFlingDiscard) {
                await discardTile(tile.id);
            } else if (targetSlotIdx !== undefined) {
                if (targetSlotIdx !== draggingIdx) playSound(moveAudio);
                setRackSlots(prev => {
                    const next = [...prev];
                    const temp = next[targetSlotIdx];
                    next[targetSlotIdx] = next[draggingIdx];
                    next[draggingIdx] = temp;
                    return next;
                });
            }
        } else if (draggingIdx === -100) {
            // Dragging FROM deck
            if (isRack || targetSlotIdx !== undefined) {
                await drawTile(targetSlotIdx);
            }
        } else if (draggingIdx === -101) {
            // Dragging FROM discarded
            if (isRack || targetSlotIdx !== undefined) {
                await drawDiscard(targetSlotIdx);
            }
        }

        setDraggingIdx(null);
        setDragPos({ x: 0, y: 0 });
    };

    useEffect(() => {
        if (draggingIdx !== null) {
            window.addEventListener('pointermove', handlePointerMove);
            window.addEventListener('pointerup', handlePointerUp);
        }
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };
    }, [draggingIdx]);


    const renderTile = (tile: Tile, onClick?: () => void) => {
        const jokerNumber = okeyTile ? (okeyTile.number % 13) + 1 : -1;
        const isActuallyOkey = okeyTile && tile.color === okeyTile.color && tile.number === jokerNumber;
        const isOkey = tile.isJoker || tile.isFakeJoker || isActuallyOkey;

        const colorClass = {
            red: 'text-red-500',
            blue: 'text-blue-500',
            black: 'text-slate-900',
            yellow: 'text-amber-500',
            fake: 'text-orange-700'
        }[tile.color] || 'text-gray-800';

        return (
            <div
                key={tile.id}
                onClick={onClick}
                className={`tile-3d w-9 h-12 rounded-lg flex flex-col items-center justify-center border border-amber-200/40 bg-amber-50 shadow-md ${isOkey ? 'ring-2 ring-amber-400 animate-okey-glow' : ''}`}
            >
                <span className={`text-[14px] font-black leading-none ${colorClass}`}>
                    {tile.isFakeJoker ? (jokerNumber > 0 ? jokerNumber : '?') : tile.number}
                </span>
                <div className="w-1.5 h-1.5 border border-black/10 rounded-full mt-0.5 shadow-inner"
                    style={{ backgroundColor: (tile.color === 'fake' || tile.isFakeJoker) && okeyTile ? okeyTile.color : (tile.color === 'yellow' ? '#f59e0b' : tile.color === 'black' ? '#0f172a' : tile.color) }}>
                </div>
            </div>
        );
    };

    const renderGameTile = (tile: Tile, onClick?: () => void, dragIdx?: number) => {
        const jokerNumber = okeyTile ? (okeyTile.number % 13) + 1 : -1;
        const isActuallyOkey = okeyTile && tile.color === okeyTile.color && tile.number === jokerNumber;
        const isOkey = tile.isJoker || tile.isFakeJoker || isActuallyOkey;
        const isSelected = selectedTileIds.has(tile.id);
        const isFlipped = flippedTileIds.has(tile.id);
        const isDragging = dragIdx !== undefined && draggingIdx === dragIdx;
        const isNewlyDrawn = tile.id === lastDrawnTileId;

        const colorClass = {
            red: 'text-red-600',
            blue: 'text-blue-500',
            black: 'text-slate-900',
            yellow: 'text-amber-600',
            fake: 'text-orange-700'
        }[tile.color] || 'text-gray-800';

        return (
            <div
                key={tile.id}
                onPointerDown={(e) => dragIdx !== undefined && handleDragStart(e, dragIdx)}
                onClick={onClick}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    setFlippedTileIds(prev => {
                        const next = new Set(prev);
                        if (next.has(tile.id)) next.delete(tile.id);
                        else next.add(tile.id);
                        return next;
                    });
                }}
                className={`tile-3d w-11 h-16 rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all border border-amber-200/50 
                    ${isSelected ? 'selected' : ''} 
                    ${isNewlyDrawn ? 'ring-2 ring-green-400 shadow-[0_0_12px_rgba(74,222,128,0.6)] -translate-y-1' : ''}
                    ${isOkey ? 'ring-2 ring-amber-400 animate-okey-glow shadow-lg' : ''} 
                    ${isFlipped ? 'bg-gradient-to-br from-amber-50 to-amber-200 !shadow-inner' : 'bg-amber-50'} 
                    ${isDragging ? 'opacity-0 scale-90' : 'opacity-100'}`}
                style={{ touchAction: 'none' }}
            >
                {isFlipped ? (
                    <div className="flex flex-col items-center justify-center pointer-events-none">
                        <span className="text-2xl text-amber-600 animate-pulse">★</span>
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-400/50 mt-1"></div>
                    </div>
                ) : (
                    <>
                        <div className="relative pointer-events-none">
                            <span className={`text-[22px] font-black tracking-tight ${colorClass} ${isOkey ? 'drop-shadow-sm' : ''}`}>
                                {tile.isFakeJoker ? (jokerNumber > 0 ? jokerNumber : '?') : tile.number}
                            </span>
                            {isOkey && !tile.isFakeJoker && (
                                <div className="absolute -top-1 -right-3 text-[10px] text-amber-600 font-bold">★</div>
                            )}
                            {tile.isFakeJoker && (
                                <div className="absolute -top-1 -right-4 text-[9px] bg-amber-500 text-black font-black px-1 rounded-sm shadow-sm scale-75">SAHTE</div>
                            )}
                        </div>
                        <div className="w-2 h-2 border border-black/10 rounded-full mt-0.5 shadow-inner pointer-events-none"
                            style={{ backgroundColor: (tile.color === 'fake' || tile.isFakeJoker) && okeyTile ? okeyTile.color : (tile.color === 'yellow' ? '#d97706' : tile.color === 'black' ? '#0f172a' : tile.color) }}>
                        </div>
                    </>
                )}
            </div>
        );
    };

    const myId = getUserInfo().userId;
    const myIndex = Array.isArray(members) ? members.findIndex(m => m.userId === myId) : -1;
    const myMember = Array.isArray(members) ? members.find(m => m.userId === myId) : null;
    const mySeat = myMember?.seat ?? -1;

    const getPlayerByRelativePos = (pos: number) => {
        if (members.length === 0) return null;
        // pos: 0=Me(Bottom), 1=Right, 2=Top, 3=Left
        const idx = (myIndex + pos) % members.length;
        return members[idx];
    };

    const handleAddToSet = (targetUserId: string, setIndex: number) => {
        if (selectedTileIds.size !== 1) return;
        const tileId = Array.from(selectedTileIds)[0];
        socketRef.current?.emit('addToSet', { targetUserId, setIndex, tileId }, (err?: string) => {
            if (err) alert(err);
            else setSelectedTileIds(new Set());
        });
    };

    const renderOpenSetsArea = (player: Member | null) => {
        if (!player || !player.openSets || player.openSets.length === 0) return null;
        return (
            <div className="flex flex-wrap gap-1.5 justify-center items-start p-2 max-h-[120px] w-full overflow-y-auto no-scrollbar bg-black/30 rounded-2xl border border-white/5 backdrop-blur-sm shadow-xl">
                {player.openSets.map((set: Tile[], sIdx: number) => (
                    <div
                        key={sIdx}
                        onClick={() => handleAddToSet(player.userId, sIdx)}
                        className="flex gap-0 scale-90 origin-top bg-white/5 p-0.5 rounded border border-white/5 hover:border-amber-500/50 hover:bg-white/10 transition-all cursor-pointer relative group"
                    >
                        {set.map(t => renderTile(t))}
                    </div>
                ))}
            </div>
        );
    };

    const CircularTimer: React.FC<{ time: number, max: number }> = ({ time, max }) => {
        const percentage = (time / max) * 100;
        const radius = 46; // Larger radius to wrap the avatar
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (percentage / 100) * circumference;
        const isCritical = time <= 10;
        const isWarning = time <= 20 && time > 10;

        return (
            <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none z-10" viewBox="0 0 100 100">
                <circle
                    cx="50" cy="50" r={radius}
                    fill="transparent"
                    stroke="rgba(255,255,255,0.05)"
                    strokeWidth="4"
                />
                <circle
                    cx="50" cy="50" r={radius}
                    fill="transparent"
                    stroke={isCritical ? '#ef4444' : isWarning ? '#f59e0b' : '#10b981'}
                    strokeWidth="4"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    className="transition-all duration-1000 ease-linear shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                />
            </svg>
        );
    };

    const PlayerSpot: React.FC<{ player: Member | null; isTurn: boolean; relativePos: number }> = ({ player, isTurn, relativePos }) => {
        return (
            <div className={`absolute flex flex-col items-center pointer-events-auto transition-all duration-700 z-50
                ${relativePos === 0 ? 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 mb-4' : ''}
                ${relativePos === 1 ? 'right-0 top-1/2 -translate-y-1/2 translate-x-1/2 mr-4' : ''}
                ${relativePos === 2 ? 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 mt-4 flex-col-reverse' : ''}
                ${relativePos === 3 ? 'left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 ml-4' : ''}`}
            >
                <div className="relative">
                    {/* Turn Glow Effect */}
                    <div className={`absolute -inset-6 bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-full blur-2xl transition-all duration-700
                        ${isTurn ? 'opacity-100 scale-125 animate-pulse' : 'opacity-0 scale-90'}`} />

                    {/* Avatar Container */}
                    <div className={`relative w-24 h-24 rounded-full p-1 transition-all duration-500 transform
                        ${isTurn ? 'scale-110' : 'opacity-80'}`}
                    >
                        <div className="w-full h-full rounded-full bg-slate-900 flex items-center justify-center overflow-hidden border-2 border-white/10 relative z-20">
                            {player ? (
                                <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${player.userId}`} alt="Avatar" className="w-full h-full object-cover" />
                            ) : (
                                <div className="w-full h-full bg-white/5 flex items-center justify-center">
                                    <span className="text-white/20 text-4xl font-black">?</span>
                                </div>
                            )}
                        </div>

                        {/* Circular Progress Timer (Full Wrap) */}
                        {isTurn && <CircularTimer time={timeRemaining} max={120} />}
                    </div>
                </div>

                <div className={`${relativePos === 2 ? 'mb-4' : 'mt-4'} flex flex-col items-center z-30`}>
                    <div className={`px-4 py-1.5 rounded-full backdrop-blur-md border transition-all duration-500
                        ${isTurn ? 'bg-amber-500/90 border-amber-300 shadow-lg scale-110' : 'bg-black/40 border-white/5'}`}
                    >
                        <span className={`text-[10px] font-black uppercase tracking-widest ${isTurn ? 'text-black' : 'text-white/80'}`}>
                            {player ? player.name : 'Bekleniyor...'}
                        </span>
                    </div>
                    {player && (
                        <div className="mt-1 px-3 py-0.5 bg-black/30 rounded-full border border-white/10 shadow-lg">
                            <span className="text-[10px] font-black text-amber-500">{player.penaltyScore || 0}</span>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderFinishModal = () => {
        if (!showFinishModal || !finishData) return null;

        const winners = [...finishData.members].sort((a, b) => (a.penaltyScore || 0) - (b.penaltyScore || 0));

        return (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-xl animate-in fade-in duration-500"></div>

                <div className="relative w-full max-w-xl bg-gradient-to-b from-white/10 to-white/5 border border-white/10 rounded-[40px] shadow-2xl overflow-hidden p-8 animate-in zoom-in-95 fade-in duration-500">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-1 bg-gradient-to-r from-transparent via-amber-500 to-transparent opacity-50"></div>

                    <div className="flex flex-col items-center mb-8">
                        <div className="w-20 h-20 bg-amber-500/20 rounded-full flex items-center justify-center mb-4 border border-amber-500/30">
                            <span className="text-4xl">🏆</span>
                        </div>
                        <h2 className="text-3xl font-black text-white uppercase tracking-[0.2em]">
                            {finishData.isFinal ? t('gameFinishedTitle') : `EL BİTTİ (${finishData.currentRound}/${finishData.maxRounds})`}
                        </h2>
                        <p className="text-amber-500 font-bold uppercase tracking-widest mt-2">{t(`gameFinishedReason_${finishData.reason}`)}</p>
                    </div>

                    <div className="space-y-3 mb-10">
                        <h3 className="text-[10px] items-center flex justify-center uppercase font-black opacity-40 tracking-[0.3em] mb-4 text-white">
                            {finishData.isFinal ? t('finalScores') : 'EL SKORLARI'}
                        </h3>
                        {winners.map((m, idx) => (
                            <div key={idx}
                                className={`flex items-center justify-between p-4 rounded-2xl border transition-all duration-500
                                    ${idx === 0 ? 'bg-amber-500/20 border-amber-500/30 scale-105 shadow-lg shadow-amber-500/5' : 'bg-white/5 border-white/5'}`}
                            >
                                <div className="flex items-center space-x-4">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-sm
                                        ${idx === 0 ? 'bg-amber-500 text-black' : 'bg-white/10 text-white/40'}`}>
                                        {idx + 1}
                                    </div>
                                    <div className="flex items-center space-x-3">
                                        <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${m.userId}`} alt="Avatar" className="w-10 h-10 rounded-full bg-white/5 border border-white/10" />
                                        <div className="flex flex-col">
                                            <span className={`font-bold ${idx === 0 ? 'text-white' : 'text-white/80'}`}>{m.name}</span>
                                            <span className="text-[10px] text-white/40 uppercase font-black tracking-tighter">
                                                {m.userId === getUserInfo().userId ? t('you') : idx === 0 ? 'Kazanan' : 'Oyuncu'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-col items-end">
                                    <span className={`text-xl font-black ${idx === 0 ? 'text-amber-400' : 'text-white'}`}>
                                        {m.penaltyScore || 0}
                                    </span>
                                    <span className="text-[9px] text-white/20 uppercase font-black tracking-widest">
                                        Toplam: {m.totalPenaltyScore || 0}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <button
                            onClick={() => navigate('/dashboard')}
                            className="py-5 bg-white/5 border border-white/10 rounded-2xl text-white font-black uppercase tracking-[0.2em] hover:bg-white/10 transition-all"
                        >
                            {t('backToMainMenu')}
                        </button>
                        <button
                            onClick={() => {
                                if (!finishData?.isFinal && getPlayerByRelativePos(0)?.host) {
                                    socketRef.current?.emit('startNextRound', gameId);
                                } else {
                                    navigate('/lobby/default');
                                }
                            }}
                            className="py-5 bg-gradient-to-r from-amber-500 to-orange-600 rounded-2xl text-black font-black uppercase tracking-[0.2em] shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all"
                        >
                            {!finishData?.isFinal && getPlayerByRelativePos(0)?.host ? 'SIRADAKİ ELE GEÇ' : t('continueAction')}
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    const toggleTileSelection = (tileId: string) => {
        setSelectedTileIds(prev => {
            const next = new Set(prev);
            if (next.has(tileId)) next.delete(tileId);
            else next.add(tileId);
            return next;
        });
    };

    const isMyTurn = turnIndex === mySeat;

    return (
        <div className={`h-screen w-screen bg-okey-table flex flex-col overflow-hidden text-white font-sans transition-all duration-700 ${isMyTurn ? 'ring-inset ring-8 ring-green-500/20' : ''}`}>
            {/* Top HUD */}
            <div className="h-14 w-full flex items-center justify-between px-6 glass-hud z-50 border-b border-white/5">
                <div className="flex items-center space-x-6">
                    <div className="flex items-center group cursor-help">
                        <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center mr-2 border border-amber-500/30 group-hover:scale-110 transition-transform">
                            <span className="text-amber-500 text-sm">💰</span>
                        </div>
                        <span className="font-extrabold text-[13px] tracking-tight">500,000</span>
                    </div>
                </div>

                <div className="flex flex-col items-center">
                    <div className="bg-gradient-to-b from-green-500/80 to-green-700/80 px-5 py-1 rounded-b-2xl border-x border-b border-white/20 flex items-center shadow-2xl backdrop-blur-md">
                        <div className="w-6 h-6 rounded-full overflow-hidden mr-2 ring-1 ring-white/50 shadow-inner">
                            <img src="https://api.dicebear.com/7.x/pixel-art/svg?seed=Hakan" alt="avatar" />
                        </div>
                        <span className="text-[11px] font-black tracking-widest uppercase notranslate" translate="no">{getUserInfo().name}</span>
                    </div>
                    <div className="text-[8px] font-black text-white/30 tracking-[0.3em] uppercase mt-0.5">
                        {t('modeEl')} {currentRound} / {maxRounds}
                    </div>
                </div>

                <div className="flex items-center space-x-3">
                    <button
                        onClick={() => setShowChat(true)}
                        className="h-9 btn-premium btn-blue px-6 text-[11px]"
                    >
                        {t('chat')}
                    </button>
                    <button
                        onClick={() => navigate('/dashboard')}
                        className="w-9 h-9 flex items-center justify-center bg-red-600/10 hover:bg-red-600/30 text-red-500 rounded-xl transition-all border border-red-500/20 group shadow-lg"
                        title={t('quitGame') || 'Oyundan Ayrıl'}
                    >
                        <span className="text-lg group-hover:rotate-12 transition-transform">🚪</span>
                    </button>
                </div>
            </div>

            {/* Main Game Area */}
            <div className="flex-1 relative flex items-center justify-center p-8 overflow-hidden">
                {/* Drag-to-discard visual hints */}
                {draggingIdx !== null && draggingIdx >= 0 && (
                    <>
                        <div className={`absolute top-0 left-0 right-0 h-28 z-[100] flex items-center justify-center transition-all duration-200 pointer-events-none
                            ${dragPos.y < -80 ? 'bg-red-500/40 border-b-4 border-red-400 shadow-[0_0_40px_rgba(239,68,68,0.5)]' : 'bg-red-500/10 border-b-2 border-dashed border-red-500/30'}`}>
                            <span className="text-red-300 text-xs font-black tracking-widest uppercase flex items-center gap-2">↑ AT</span>
                        </div>
                        <div className={`absolute top-0 right-0 bottom-0 w-28 z-[100] flex items-center justify-center transition-all duration-200 pointer-events-none
                            ${dragPos.x > 120 ? 'bg-red-500/40 border-l-4 border-red-400 shadow-[0_0_40px_rgba(239,68,68,0.5)]' : 'bg-red-500/10 border-l-2 border-dashed border-red-500/30'}`}>
                            <span className="text-red-300 text-xs font-black tracking-widest uppercase flex items-center gap-2 [writing-mode:vertical-lr]">→ AT</span>
                        </div>
                    </>
                )}

                {/* Table Surface - The Green Play Area */}
                <div className="w-[88%] h-[78%] table-surface rounded-[80px] relative shadow-[0_40px_100px_rgba(0,0,0,0.6)] border-4 border-white/5">
                    {/* Table quadrants for Opened Sets - Positioned in front of players */}
                    <div className="absolute inset-0 z-10 pointer-events-none p-4 lg:p-8">
                        <div className="grid grid-cols-3 grid-rows-3 w-full h-full gap-4">
                            {/* TOP: Player 2 hands */}
                            <div className="col-start-1 col-end-4 row-start-1 flex items-start justify-center pt-4">
                                {renderOpenSetsArea(getPlayerByRelativePos(2))}
                            </div>
                            {/* LEFT: Player 3 hands */}
                            <div className="col-start-1 row-start-2 flex items-center justify-start pl-4">
                                <div className="w-[280px]">{renderOpenSetsArea(getPlayerByRelativePos(3))}</div>
                            </div>
                            {/* RIGHT: Player 1 hands */}
                            <div className="col-start-3 row-start-2 flex items-center justify-end pr-4">
                                <div className="w-[280px]">{renderOpenSetsArea(getPlayerByRelativePos(1))}</div>
                            </div>
                            {/* BOTTOM: Your hands */}
                            <div className="col-start-1 col-end-4 row-start-3 flex items-end justify-center pb-4">
                                {renderOpenSetsArea(getPlayerByRelativePos(0))}
                            </div>
                        </div>
                    </div>

                    {/* Table Markers & Logo */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
                        <div className="relative flex flex-col items-center">
                            <span className="text-[180px] font-black tracking-tighter leading-none">101</span>
                            <span className="text-xl font-black tracking-[1em] -mt-8">PLUS</span>
                        </div>
                    </div>

                    {/* Table Center Info */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-48 flex flex-col items-center space-y-1 z-0">
                        <div className="px-4 py-1.5 bg-black/40 rounded-full border border-white/5 backdrop-blur-md flex items-center space-x-3 shadow-xl">
                            <span className="text-[10px] font-black opacity-40 uppercase tracking-widest">Masa</span>
                            <span className="text-[11px] font-bold text-amber-500">#{gameId?.slice(-4).toUpperCase()}</span>
                            <div className="w-[1px] h-3 bg-white/10"></div>
                            <span className="text-[11px] font-bold text-green-400">25,000</span>
                        </div>
                    </div>

                    {/* Discard Pile */}
                    <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                        <div id="discard-zone" className="relative w-56 h-44">
                            {discardHistory.length === 0 && (
                                <div className="absolute inset-0 flex items-center justify-center opacity-10">
                                    <div className="w-14 h-20 border-2 border-dashed border-white/50 rounded-xl flex items-center justify-center">
                                        <span className="text-xl font-black">∅</span>
                                    </div>
                                </div>
                            )}
                            {discardHistory.map((entry, idx) => {
                                const isLatest = idx === discardHistory.length - 1;
                                const tile = entry.tile;
                                const seed = idx * 137.508;
                                const rotDeg = ((seed % 30) - 15);
                                const offX = ((seed * 1.5) % 100) - 50;
                                const offY = ((seed * 0.8) % 80) - 40;
                                return (
                                    <div
                                        key={idx}
                                        style={{
                                            position: 'absolute', top: '50%', left: '50%',
                                            transform: `translate(calc(-50% + ${offX}px), calc(-50% + ${offY}px)) rotate(${rotDeg}deg)`,
                                            zIndex: idx, pointerEvents: isLatest ? 'auto' : 'none'
                                        }}
                                        className={`transition-all duration-300 ${isLatest && draggingIdx === -101 ? 'opacity-0 scale-50' : 'opacity-100'}`}
                                        onMouseDown={(e) => isLatest && handleDragStart(e as unknown as React.PointerEvent, -101)}
                                    >
                                        {renderTile(tile)}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Player Avatars - Outside the green table */}
                <div className="absolute inset-0 max-w-7xl mx-auto pointer-events-none z-30">
                    <PlayerSpot player={getPlayerByRelativePos(0)} isTurn={turnIndex === (getPlayerByRelativePos(0)?.seat ?? -1)} relativePos={0} />
                    <PlayerSpot player={getPlayerByRelativePos(1)} isTurn={turnIndex === (getPlayerByRelativePos(1)?.seat ?? -1)} relativePos={1} />
                    <PlayerSpot player={getPlayerByRelativePos(2)} isTurn={turnIndex === (getPlayerByRelativePos(2)?.seat ?? -1)} relativePos={2} />
                    <PlayerSpot player={getPlayerByRelativePos(3)} isTurn={turnIndex === (getPlayerByRelativePos(3)?.seat ?? -1)} relativePos={3} />
                </div>

                {/* Bottom HUD - Flanking player avatar (Moved to bottom edges to avoid overlapping open sets) */}
                {/* Deck - Left Side */}
                <div className="absolute bottom-4 left-[2%] sm:left-[5%] md:left-[10%] xl:left-[15%] z-40 pointer-events-auto">
                    <div className="flex flex-col items-center bg-black/60 px-4 py-4 rounded-3xl border border-white/10 backdrop-blur-md shadow-2xl transform -rotate-2">
                        <span className="text-[7px] uppercase font-black opacity-30 mb-1 tracking-widest text-white whitespace-nowrap">{t('deckLabel')}</span>
                        <div className={`relative group ${hasDrawn || !isMyTurn ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                            onClick={() => { if (!hasDrawn && isMyTurn) drawTile(); }}
                        >
                            <div className="absolute -top-1 -left-1 w-8 h-12 bg-white/10 rounded-md -rotate-3 border border-black/20"></div>
                            <div className={`w-8 h-12 bg-gradient-to-br from-white to-gray-200 rounded-md shadow-xl flex flex-col items-center justify-center -rotate-1 group-hover:rotate-0 transition-transform ${hasDrawn ? 'border-green-400' : 'border-gray-400'}`}>
                                <span className="text-black font-black text-lg leading-none">{deckCount}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Okey Tile - Right Side */}
                <div className="absolute bottom-4 right-[2%] sm:right-[5%] md:right-[10%] xl:right-[15%] z-40 pointer-events-auto flex gap-4 items-end">
                    <div className="flex flex-col items-center glass-hud py-2 px-3 rounded-2xl border border-white/10 bg-black/60 shadow-2xl transform rotate-2">
                        <span className="text-[7px] uppercase font-black opacity-30 mb-1 tracking-widest text-amber-500 whitespace-nowrap">{t('okeyTile')}</span>
                        <div className="scale-75">{okeyTile && renderTile(okeyTile)}</div>
                    </div>
                    {/* Stats Button */}
                    <div className="relative group pb-2">
                        <div className="w-10 h-10 bg-black/60 rounded-full border border-white/10 flex items-center justify-center hover:w-32 hover:rounded-xl transition-all overflow-hidden cursor-help shadow-2xl">
                            <span className="text-sm shrink-0">📊</span>
                            <div className="hidden group-hover:flex flex-col ml-2 pr-2">
                                {members.slice(0, 4).map(m => (
                                    <div key={m.userId} className="flex justify-between w-20 text-[8px] font-black uppercase">
                                        <span className="truncate mr-1">{m.name}</span>
                                        <span className="text-amber-400">{m.penaltyScore || 0}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Pending Sets Area */}
                {pendingSets.length > 0 && (
                    <div className="absolute top-[12%] left-1/2 -translate-x-1/2 flex flex-nowrap gap-4 justify-start items-center animate-okey-glow max-w-[90%] p-4 rounded-3xl bg-black/40 border border-white/10 backdrop-blur-md overflow-x-auto no-scrollbar scroll-smooth z-30 shadow-2xl">
                        {pendingSets.map((set, idx) => (
                            <div key={idx} className="flex gap-0.5 bg-black/40 p-2 rounded-xl border border-white/10 relative group shrink-0">
                                {set.map(t => renderTile(t))}
                                <button
                                    onClick={() => {
                                        setHand(prev => [...prev, ...set]);
                                        setPendingSets(prev => prev.filter((_, i) => i !== idx));
                                    }}
                                    className="absolute -top-2 -right-2 w-6 h-6 bg-red-600 text-white rounded-full flex items-center justify-center text-[11px] opacity-0 group-hover:opacity-100 transition-all shadow-xl hover:scale-125 z-10"
                                >✕</button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Bottom Section: Rack & Controls */}
            <div className="h-52 w-full flex flex-col items-center justify-end px-4 relative pb-2 overflow-visible">
                {/* HUD Info Area Above Rack */}
                <div className="absolute -top-12 left-1/2 -translate-x-1/2 flex items-center space-x-4 z-40">
                    <div className="bg-black/60 px-5 py-2 rounded-full backdrop-blur-md border border-white/10 flex items-center space-x-6 shadow-2xl">
                        <div className="flex items-center space-x-1">
                            {pendingSets.length >= 5 && pendingSets.every(s => s.length === 2) ? (
                                <><span className="text-xs font-black text-blue-400">ÇİFT:</span><span className="text-sm font-black text-green-400">{pendingSets.length}</span></>
                            ) : (
                                <><span className="text-xs font-black text-amber-500">101?</span><span className={`text-sm font-black ${pendingSets.flat().reduce((acc, t) => acc + (t.number === 0 ? 0 : t.number), 0) >= 101 ? 'text-green-400' : 'text-white'}`}>{pendingSets.flat().reduce((acc, t) => acc + (t.number === 0 ? 0 : t.number), 0)}</span></>
                            )}
                        </div>
                        <div className="w-[1px] h-4 bg-white/20"></div>
                        <span className={`text-[10px] font-black uppercase tracking-widest ${isMyTurn ? 'text-green-400 animate-pulse' : 'text-white/40'}`}>
                            {isMyTurn ? t('yourTurnMsg') : t('opponentTurnMsg')}
                        </span>
                    </div>
                </div>

                <div className="w-full max-w-[1300px] flex items-center justify-center space-x-4">
                    {/* Controls Left */}
                    <div className="flex flex-col space-y-3 mr-6">
                        <div className="flex flex-col space-y-2">
                            <span className="text-[9px] font-black opacity-30 text-center uppercase tracking-widest">DİZİLİM</span>
                            <button onClick={sortSeri} className="w-12 h-12 btn-premium btn-blue flex flex-col items-center justify-center group"><span className="text-lg group-hover:scale-110 transition-transform">🪜</span><span className="text-[8px] font-black uppercase mt-0.5">SERİ</span></button>
                            <button onClick={sortCift} className="w-12 h-12 btn-premium btn-blue flex flex-col items-center justify-center group"><span className="text-lg group-hover:scale-110 transition-transform">👥</span><span className="text-[8px] font-black uppercase mt-0.5">ÇİFT</span></button>
                        </div>
                        <button onClick={undoDrawDiscard} disabled={!mustOpen} className={`w-12 h-10 btn-premium btn-red flex flex-col items-center justify-center transition-all ${!mustOpen ? 'opacity-20 grayscale' : 'animate-pulse'}`}><span className="text-xs">↩</span><span className="text-[7px] font-black uppercase">GERİ</span></button>
                    </div>

                    {/* Wooden İsteka (Rack) */}
                    <div className="relative flex-1 max-w-[1100px] h-40 bg-isteka rounded-2xl p-4 flex flex-col justify-between shadow-[0_20px_50px_rgba(0,0,0,0.8)] border-t-2 border-white/20">
                        <div className="isteka-row w-full flex items-center justify-center gap-1">
                            {rackSlots.slice(0, 22).map((tile, i) => (
                                <div key={i} data-slot-idx={i} className={`w-[48px] h-[68px] flex items-center justify-center relative ${draggingIdx !== null ? 'hover:bg-white/5 rounded-lg' : ''}`}>
                                    {tile && renderGameTile(tile, () => toggleTileSelection(tile.id), i)}
                                    {!tile && <div className="absolute inset-1 border border-dashed border-white/5 rounded-lg pointer-events-none"></div>}
                                </div>
                            ))}
                        </div>
                        <div className="isteka-row w-full flex items-center justify-center gap-1">
                            {rackSlots.slice(22, 44).map((tile, i) => {
                                const idx = i + 22;
                                return (
                                    <div key={idx} data-slot-idx={idx} className={`w-[48px] h-[68px] flex items-center justify-center relative ${draggingIdx !== null ? 'hover:bg-white/5 rounded-lg' : ''}`}>
                                        {tile && renderGameTile(tile, () => toggleTileSelection(tile.id), idx)}
                                        {!tile && <div className="absolute inset-1 border border-dashed border-white/5 rounded-lg pointer-events-none"></div>}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Controls Right */}
                    <div className="flex flex-col space-y-3 ml-4">
                        <div className="flex flex-col space-y-1.5">
                            <span className="text-[9px] font-black opacity-40 text-center uppercase tracking-widest leading-none mb-1">HAMLE</span>
                            <div className="flex flex-col gap-2">
                                <button onClick={addGroup} className="w-14 h-14 btn-premium btn-green border-2 border-green-400/30 flex flex-col items-center justify-center group shadow-xl"><span className="text-2xl group-hover:scale-110 transition-transform">📦</span><span className="text-[9px] font-black uppercase mt-1">{t('addGroup')}</span></button>
                                <button onClick={async () => { if (pendingSets.length === 0) return alert(t('noSetsToOpen')); await placeSets(pendingSets); }}
                                    className="w-14 h-14 btn-premium btn-amber border-2 border-amber-400/30 flex flex-col items-center justify-center group shadow-xl"><span className="text-2xl group-hover:scale-110 transition-transform">📤</span><span className="text-[9px] font-black uppercase mt-1">{t('placeOnTable')}</span></button>
                            </div>
                        </div>
                        <div className="flex flex-col space-y-1.5">
                            <span className="text-[9px] font-black opacity-40 text-center uppercase tracking-widest leading-none mb-1">BİTİR</span>
                            <button id="discard-zone-btn"
                                onClick={async () => { if (selectedTileIds.size !== 1) return alert(t('selectOneToDiscard')); await discardTile([...selectedTileIds][0]); setSelectedTileIds(new Set()); }}
                                className="w-14 h-14 btn-premium btn-red border-2 border-red-400/30 flex flex-col items-center justify-center group shadow-xl"><span className="text-2xl group-hover:-translate-y-1 transition-transform">🗑️</span><span className="font-black text-[10px] mt-1 uppercase">{t('discardAction')}</span></button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Chat Overlay */}
            <div className={`fixed top-14 right-0 bottom-0 w-80 glass-hud z-[200] border-l border-white/10 transition-transform duration-500 shadow-3xl flex flex-col ${showChat ? 'translate-x-0' : 'translate-x-full'}`}>
                <div className="p-4 border-b border-white/10 bg-white/5 flex items-center justify-between">
                    <h3 className="text-xs font-black uppercase tracking-widest">SOHBET</h3>
                    <button onClick={() => setShowChat(false)} className="opacity-40 hover:opacity-100 transition-opacity">✕</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3 no-scrollbar bg-black/20">
                    {chat.map((msg, idx) => (
                        <div key={idx} className={`flex flex-col ${msg.user === getUserInfo().name ? 'items-end' : 'items-start'}`}>
                            <span className="text-[8px] font-black opacity-30 uppercase mb-1">{msg.user}</span>
                            <div className={`px-3 py-1.5 rounded-2xl text-[11px] max-w-[90%] break-words ${msg.user === getUserInfo().name ? 'bg-amber-500/20 border-amber-500/20 text-amber-50' : 'bg-white/5 border-white/10 text-white'}`}>{msg.text}</div>
                        </div>
                    ))}
                    <div ref={chatEndRef} />
                </div>
                <form onSubmit={sendMessage} className="p-4 bg-black/40 border-t border-white/10 flex space-x-2">
                    <input type="text" value={msgInput} onChange={(e) => setMsgInput(e.target.value)} placeholder={t('typeMessage')} className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs focus:outline-none focus:border-amber-500/50 transition-colors" />
                    <button type="submit" className="w-10 h-10 flex items-center justify-center bg-amber-500 text-black rounded-xl hover:scale-105 shadow-lg">➤</button>
                </form>
            </div>

            {/* Ghost Overlay */}
            {draggingIdx !== null && (
                <div className="fixed pointer-events-none z-[9999] scale-110 shadow-3xl opacity-90"
                    style={{ left: dragStart.x + dragPos.x - 22, top: dragStart.y + dragPos.y - 32, width: 44, height: 64 }}>
                    {draggingIdx >= 0 && rackSlots[draggingIdx] ? renderGameTile(rackSlots[draggingIdx]!) :
                        draggingIdx === -100 ? (
                            <div className="w-11 h-16 bg-white rounded-lg shadow-2xl flex items-center justify-center border-b-4 border-gray-300">
                                <div className="w-6 h-6 rounded-full bg-blue-600/10"></div>
                            </div>
                        ) : (draggingIdx === -101 && lastDiscard) ? renderTile(lastDiscard) : null}
                </div>
            )}

            {renderFinishModal()}
            {isGameEnded && !showFinishModal && (
                <div className="fixed bottom-48 left-1/2 -translate-x-1/2 z-[150] animate-in fade-in slide-in-from-bottom-4">
                    <button onClick={() => setShowFinishModal(true)} className="btn-premium btn-amber px-12 py-4 text-sm tracking-[0.2em] font-black rounded-3xl shadow-2xl flex items-center space-x-3 group">
                        <span>{t('gameFinishedTitle').toUpperCase()} - SONUÇLARI GÖR</span><span className="group-hover:translate-x-1 transition-transform">🏆</span>
                    </button>
                </div>
            )}
        </div>
    );
};

export default GameBoard;
