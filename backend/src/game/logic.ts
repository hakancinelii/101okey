// src/game/logic.ts
import { Tile, Color } from './rules';

export function generateTilePool(gameSeed?: string): Tile[] {
    const colors: Color[] = ['red', 'blue', 'black', 'yellow'];
    const pool: Tile[] = [];
    const seed = gameSeed || Math.random().toString(36).substring(2, 7);

    // Each color has tiles 1-13, two of each
    colors.forEach((color) => {
        for (let num = 1; num <= 13; num++) {
            pool.push({ id: `${seed}-${color}-${num}-1`, color, number: num });
            pool.push({ id: `${seed}-${color}-${num}-2`, color, number: num });
        }
    });

    // Plus 2 Fake Jokers
    pool.push({ id: `${seed}-fake-1`, color: 'fake', number: 0, isFakeJoker: true });
    pool.push({ id: `${seed}-fake-2`, color: 'fake', number: 0, isFakeJoker: true });

    return pool;
}

export function shuffle<T>(array: T[]): T[] {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

export function distributeTiles(pool: Tile[], memberCount: number): { hands: Tile[][], remainingPool: Tile[] } {
    const hands: Tile[][] = [];
    let currentPool = [...pool];

    for (let i = 0; i < memberCount; i++) {
        // Standard 101 Okey distribution:
        // Usually 21 tiles for each player, creator gets 22
        const count = i === 0 ? 22 : 21;
        const hand = currentPool.splice(0, count);
        hands.push(hand);
    }

    return { hands, remainingPool: currentPool };
}
export function calculateSetScore(tiles: Tile[], okeyTile: Tile): { isValid: boolean, score: number, reason?: string } {
    if (tiles.length === 2) {
        if (isPair(tiles[0], tiles[1], okeyTile)) return { isValid: true, score: 0 };
        return { isValid: false, score: 0, reason: 'INVALID_PAIR' };
    }
    if (tiles.length < 3) return { isValid: false, score: 0, reason: 'SET_TOO_SHORT' };

    const jokerNumber = (okeyTile.number % 13) + 1;
    // Normalize: Identify wildcards (Okeys) and normalize fake jokers
    const normalizedTiles = tiles.map(t => {
        // IMPORTANT: Fake Joker is NOT a wildcard. It's a tile that acts as the original tile displaced by the Okey.
        const isWildcard = t.isJoker || (!t.isFakeJoker && t.color === okeyTile.color && t.number === jokerNumber);

        let nColor = t.color;
        let nNumber = t.number;

        if (t.isFakeJoker) {
            nColor = okeyTile.color;
            nNumber = jokerNumber;
        }

        return { ...t, nColor, nNumber, isWildcard };
    });

    // Try Group
    const groupRes = isValidGroup(normalizedTiles);
    if (groupRes.isValid) {
        const nonWildcards = normalizedTiles.filter(t => !t.isWildcard);
        const baseNum = nonWildcards.length > 0 ? nonWildcards[0].nNumber : okeyTile.number;
        return { isValid: true, score: baseNum * tiles.length };
    }

    // Try Sequence
    const seqRes = getSequenceScore(normalizedTiles, okeyTile);
    if (seqRes.isValid) return seqRes;

    return { isValid: false, score: 0, reason: groupRes.reason || 'INVALID_STRUCTURE' };
}

function isValidGroup(tiles: any[]): { isValid: boolean, reason?: string } {
    if (tiles.length < 3) return { isValid: false, reason: 'SET_TOO_SHORT' };
    if (tiles.length > 4) return { isValid: false, reason: 'GROUP_TOO_LONG' };

    const nonWildcards = tiles.filter(t => !t.isWildcard);
    if (nonWildcards.length === 0) return { isValid: true };

    const baseNum = nonWildcards[0].nNumber;
    const colors = new Set();
    for (const t of nonWildcards) {
        if (t.nNumber !== baseNum) return { isValid: false, reason: 'GROUP_DIFFERENT_NUMBERS' };
        if (colors.has(t.nColor)) return { isValid: false, reason: 'GROUP_DUPLICATE_COLORS' };
        colors.add(t.nColor);
    }
    return { isValid: true };
}

function getSequenceScore(tiles: any[], okeyTile: Tile): { isValid: boolean, score: number } {
    if (tiles.length < 3) return { isValid: false, score: 0 };
    const nonWildcards = tiles.filter(t => !t.isWildcard);
    if (nonWildcards.length === 0) {
        let score = 0;
        for (let i = 0; i < tiles.length; i++) score += (okeyTile.number + i);
        return { isValid: true, score };
    }

    const color = nonWildcards[0].nColor;
    if (!nonWildcards.every(t => t.nColor === color)) return { isValid: false, score: 0 };

    const sortedNum = [...nonWildcards].sort((a, b) => a.nNumber - b.nNumber);
    for (let i = 0; i < sortedNum.length - 1; i++) {
        if (sortedNum[i].nNumber === sortedNum[i + 1].nNumber) return { isValid: false, score: 0 };
    }

    const wildcards = tiles.length - nonWildcards.length;

    const tryNormal = () => {
        let gaps = 0;
        for (let i = 0; i < sortedNum.length - 1; i++) {
            gaps += (sortedNum[i + 1].nNumber - sortedNum[i].nNumber - 1);
        }
        if (wildcards < gaps) return { isValid: false, score: 0 };

        let extra = wildcards - gaps;
        let low = sortedNum[0].nNumber;
        let high = sortedNum[sortedNum.length - 1].nNumber;
        let runningScore = 0;
        for (let i = low; i <= high; i++) runningScore += i;

        while (extra > 0) {
            if (high < 13) { high++; runningScore += high; }
            else if (low > 1) { low--; runningScore += low; }
            else return { isValid: false, score: 0 };
            extra--;
        }
        return { isValid: true, score: runningScore };
    };

    const tryWrap = () => {
        const has1 = sortedNum.some(t => t.nNumber === 1);
        const hasHigh = sortedNum.some(t => t.nNumber === 12 || t.nNumber === 13);
        if (!has1 || !hasHigh) return { isValid: false, score: 0 };

        const wrapped = sortedNum.map(t => t.nNumber === 1 ? { ...t, val: 14 } : { ...t, val: t.nNumber }).sort((a, b) => a.val - b.val);
        let gaps = 0;
        for (let i = 0; i < wrapped.length - 1; i++) {
            gaps += (wrapped[i + 1].val - wrapped[i].val - 1);
        }
        if (wildcards < gaps) return { isValid: false, score: 0 };

        let extra = wildcards - gaps;
        let low = wrapped[0].val;
        let high = wrapped[wrapped.length - 1].val;
        let runningScore = 0;
        for (let i = low; i <= high; i++) runningScore += (i === 14 ? 1 : i);

        while (extra > 0) {
            if (low > 1) { low--; runningScore += low; }
            else return { isValid: false, score: 0 };
            extra--;
        }
        return { isValid: true, score: runningScore };
    };

    const res = tryNormal();
    if (res.isValid) return res;
    return tryWrap();
}
function isActuallyOkey(t: Tile, okey: Tile): boolean {
    if (t.isJoker) return true;
    if (t.isFakeJoker) return false; // Fake Jokers are NOT Okeys (wildcards)
    const jokerNumber = (okey.number % 13) + 1;
    return t.color === okey.color && t.number === jokerNumber;
}

function isPair(t1: Tile, t2: Tile, okeyTile: Tile): boolean {
    if (isActuallyOkey(t1, okeyTile) || isActuallyOkey(t2, okeyTile)) return true;

    // Normalize fake jokers
    const jokerNumber = (okeyTile.number % 13) + 1;
    const c1 = t1.isFakeJoker ? okeyTile.color : t1.color;
    const n1 = t1.isFakeJoker ? jokerNumber : t1.number;
    const c2 = t2.isFakeJoker ? okeyTile.color : t2.color;
    const n2 = t2.isFakeJoker ? jokerNumber : t2.number;

    return c1 === c2 && n1 === n2;
}

export function calculateMultipleSetsScore(sets: Tile[][], okeyTile: Tile): { isValid: boolean, totalScore: number, reason?: string, isPairHand?: boolean } {
    // Check if it's a "Çift" (Pair) opening attempt
    const allArePairs = sets.length >= 5 && sets.every(s => s.length === 2);
    if (allArePairs) {
        for (let i = 0; i < sets.length; i++) {
            if (!isPair(sets[i][0], sets[i][1], okeyTile)) {
                return { isValid: false, totalScore: 0, reason: `INVALID_PAIR_AT_${i + 1}`, isPairHand: true };
            }
        }
        return { isValid: true, totalScore: 1, isPairHand: true }; // Use 1 to indicate "opened" but pairs don't have sum
    }

    // Normal Seri/Grup logic
    let totalScore = 0;
    for (const set of sets) {
        const res = calculateSetScore(set, okeyTile);
        if (!res.isValid) return { isValid: false, totalScore: 0, reason: res.reason };
        totalScore += res.score;
    }
    return { isValid: true, totalScore };
}


/**
 * Calculates penalty score for a player's hand when the game ends.
 * Standard rules: 
 * - Okey in hand: 101 points
 * - Others: face value
 * - If not opened: 202 points fixed penalty
 */
export function calculateHandPenalty(hand: Tile[], okeyTile: Tile, hasOpened: boolean): number {
    if (!hasOpened) return 202;
    let total = 0;
    hand.forEach(t => {
        if (isActuallyOkey(t, okeyTile)) {
            total += 101;
        } else if (t.isFakeJoker) {
            const jokerNumber = (okeyTile.number % 13) + 1;
            total += jokerNumber;
        } else {
            total += t.number;
        }
    });
    return total === 0 ? 0 : total;
}
export function canAddTileToSet(existingSet: Tile[], newTile: Tile, okeyTile: Tile): { isValid: boolean, newSet: Tile[] } {
    // Try to create a valid set with the new tile
    const combined = [...existingSet, newTile];
    const res = calculateSetScore(combined, okeyTile);
    return { isValid: res.isValid, newSet: combined };
}
