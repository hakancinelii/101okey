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
    if (tiles.length < 3) return { isValid: false, score: 0 };

    // Mark wildcards and normalize values
    const tilesWithMeta = tiles.map(t => {
        const jokerNumber = (okeyTile.number % 13) + 1;
        const isActuallyJoker = (t.color === okeyTile.color && t.number === jokerNumber);
        const isWildcard = t.isJoker || isActuallyJoker;

        // If it's a Fake Joker, it MUST take the identity of the physical tile that became Joker
        let effectiveNumber = t.number;
        let effectiveColor = t.color;
        if (t.isFakeJoker) {
            effectiveNumber = jokerNumber;
            effectiveColor = okeyTile.color;
        }

        return { ...t, number: effectiveNumber, color: effectiveColor, isWildcard };
    });

    // Check if it's a valid group (same number, different colors)
    const groupRes = isValidGroup(tilesWithMeta);
    if (groupRes.isValid) {
        const nonWildcards = tilesWithMeta.filter(t => !t.isWildcard);
        const baseNum = nonWildcards.length > 0 ? nonWildcards[0].number : (okeyTile.number % 13) + 1;
        return { isValid: true, score: baseNum * tiles.length };
    }

    // Check if it's a valid sequence (consecutive numbers, same color)
    const seqResult = getSequenceScore(tilesWithMeta);
    if (seqResult.isValid) {
        return seqResult;
    }

    return { isValid: false, score: 0, reason: groupRes.reason || 'INVALID_STRUCTURE' };
}

function isValidGroup(tiles: any[]): { isValid: boolean, reason?: string } {
    if (tiles.length < 3) return { isValid: false, reason: 'SET_TOO_SHORT' };
    if (tiles.length > 4) return { isValid: false, reason: 'GROUP_TOO_LONG' };

    const nonWildcards = tiles.filter(t => !t.isWildcard);
    if (nonWildcards.length === 0) return { isValid: true };

    const baseNum = nonWildcards[0].number;
    const colors = new Set();
    for (const t of nonWildcards) {
        if (t.number !== baseNum) return { isValid: false, reason: 'GROUP_DIFFERENT_NUMBERS' };
        if (colors.has(t.color)) return { isValid: false, reason: 'GROUP_DUPLICATE_COLORS' };
        colors.add(t.color);
    }
    return { isValid: true };
}

function getSequenceScore(tiles: any[]): { isValid: boolean, score: number } {
    if (tiles.length < 3) return { isValid: false, score: 0 };
    const nonWildcards = tiles.filter(t => !t.isWildcard);
    if (nonWildcards.length === 0) return { isValid: true, score: 0 };

    const color = nonWildcards[0].color;
    if (!nonWildcards.every(t => t.color === color)) return { isValid: false, score: 0 };

    // Standard sort
    const sorted = [...nonWildcards].sort((a, b) => a.number - b.number);

    // Check for duplicates
    for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].number === sorted[i + 1].number) return { isValid: false, score: 0 };
    }

    const wildcardCount = tiles.length - nonWildcards.length;

    // Try normal (no wrap)
    const validateNoWrap = () => {
        let gaps = 0;
        for (let i = 0; i < sorted.length - 1; i++) {
            gaps += (sorted[i + 1].number - sorted[i].number - 1);
        }
        if (wildcardCount < gaps) return { isValid: false, score: 0 };

        let extra = wildcardCount - gaps;
        let low = sorted[0].number;
        let high = sorted[sorted.length - 1].number;
        let score = 0;
        for (let i = low; i <= high; i++) score += i;

        while (extra > 0) {
            if (high < 13) { high++; score += high; }
            else if (low > 1) { low--; score += low; }
            else return { isValid: false, score: 0 };
            extra--;
        }
        return { isValid: true, score };
    };

    // Try wrap-around (Dönüşlü: 12-13-1)
    const validateWrap = () => {
        const hasOne = sorted.some(t => t.number === 1);
        const hasHigh = sorted.some(t => t.number === 12 || t.number === 13);
        if (!hasOne || !hasHigh) return { isValid: false, score: 0 };

        // In 101 Okey, "1" in a wrap sequence always counts as the tile AFTER 13.
        // So for calculation, treat it as 14.
        const wrapSorted = sorted.map(t => t.number === 1 ? { ...t, number: 14 } : t).sort((a, b) => a.number - b.number);

        let gaps = 0;
        for (let i = 0; i < wrapSorted.length - 1; i++) {
            gaps += (wrapSorted[i + 1].number - wrapSorted[i].number - 1);
        }
        if (wildcardCount < gaps) return { isValid: false, score: 0 };

        let extra = wildcardCount - gaps;
        let low = wrapSorted[0].number;
        let high = wrapSorted[wrapSorted.length - 1].number;

        // Wrap sequence can't start below 1 (effectively 1 after 13)
        // Wait, 11-12-13-1 is valid. 12-13-1 is valid.
        // 13-1-2 is usually NOT valid.
        // So low must be at least 1 (if 1 is start) or something leading to 13.
        // In our wrapSorted, 1 is 14. So a sequence like 12, 13, 14 is fine.
        // But 14, 15... doesn't exist.

        let score = 0;
        // Treat 14 as 1 for score? Standard 101 rules: 1 after 13 counts as 1.
        for (let i = low; i <= high; i++) score += (i === 14 ? 1 : i);

        while (extra > 0) {
            // In wrap, we can only extend downwards (e.g. 11, 12, 13, 1)
            // Extending upwards from 1 (14) is illegal.
            if (low > 1) { low--; score += low; }
            else return { isValid: false, score: 0 };
            extra--;
        }
        return { isValid: true, score };
    };

    const resNormal = validateNoWrap();
    if (resNormal.isValid) return resNormal;

    return validateWrap();
}
export function calculateMultipleSetsScore(sets: Tile[][], okeyTile: Tile): { isValid: boolean, totalScore: number, reason?: string } {
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

    const jokerNumber = (okeyTile.number % 13) + 1;
    let total = 0;

    hand.forEach(t => {
        const isActuallyOkey = (t.color === okeyTile.color && t.number === jokerNumber) || t.isJoker;
        if (isActuallyOkey) {
            total += 101;
        } else if (t.isFakeJoker) {
            total += jokerNumber;
        } else {
            total += t.number;
        }
    });

    return total === 0 ? 0 : total; // Should not be 0 unless they just finished
}
export function canAddTileToSet(existingSet: Tile[], newTile: Tile, okeyTile: Tile): { isValid: boolean, newSet: Tile[] } {
    // Try to create a valid set with the new tile
    const combined = [...existingSet, newTile];
    const res = calculateSetScore(combined, okeyTile);
    return { isValid: res.isValid, newSet: combined };
}
