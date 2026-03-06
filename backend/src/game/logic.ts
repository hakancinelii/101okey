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
export function calculateSetScore(tiles: Tile[], okeyTile: Tile): { isValid: boolean, score: number } {
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
    if (isValidGroup(tilesWithMeta)) {
        const nonWildcards = tilesWithMeta.filter(t => !t.isWildcard);
        const baseNum = nonWildcards.length > 0 ? nonWildcards[0].number : (okeyTile.number % 13) + 1;
        return { isValid: true, score: baseNum * tiles.length };
    }

    // Check if it's a valid sequence (consecutive numbers, same color)
    const seqResult = getSequenceScore(tilesWithMeta);
    if (seqResult.isValid) {
        return seqResult;
    }

    return { isValid: false, score: 0 };
}

function isValidGroup(tiles: any[]): boolean {
    if (tiles.length < 3 || tiles.length > 4) return false;
    const nonWildcards = tiles.filter(t => !t.isWildcard);
    if (nonWildcards.length === 0) return true;

    const baseNum = nonWildcards[0].number;
    const colors = new Set();
    for (const t of nonWildcards) {
        if (t.number !== baseNum) return false;
        if (colors.has(t.color)) return false;
        colors.add(t.color);
    }
    return true;
}

function getSequenceScore(tiles: any[]): { isValid: boolean, score: number } {
    if (tiles.length < 3) return { isValid: false, score: 0 };
    const nonWildcards = tiles.filter(t => !t.isWildcard);
    if (nonWildcards.length === 0) {
        // All wildcards - not normally possible in 101, but for completeness:
        return { isValid: true, score: 0 }; // We can't infer values without at least one concrete tile
    }

    // All must be same color
    const color = nonWildcards[0].color;
    if (!nonWildcards.every(t => t.color === color)) return { isValid: false, score: 0 };

    // Sort non-wildcards
    const sorted = [...nonWildcards].sort((a, b) => a.number - b.number);

    // Check for duplicates
    for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].number === sorted[i + 1].number) return { isValid: false, score: 0 };
    }

    // Check gaps
    let gaps = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
        gaps += (sorted[i + 1].number - sorted[i].number - 1);
    }

    const wildcardCount = tiles.length - nonWildcards.length;
    if (wildcardCount < gaps) return { isValid: false, score: 0 };

    // We have enough wildcards. Now calculate total score.
    // In sequence, characters are consecutive. 
    // We need to find the the 'start' number of the sequence.
    // The sequence could have wildcards at the start and end.

    // Simplest way: The gap logic tells us the wildcards MUST fit between the concrete tiles.
    // Any remaining wildcards can go at either end. 
    // In 101 Okey, we usually calculate score based on the values the wildcards TAKE.

    // To find the range:
    const minNum = sorted[0].number;
    const maxNum = sorted[sorted.length - 1].number;

    // The range covered by concrete tiles is [minNum, maxNum] with total maxNum - minNum + 1 slots.
    // Number of concrete tiles is sorted.length.
    // Missing slots = (maxNum - minNum + 1) - sorted.length = gaps. (This is already checked).

    // Remaining wildcards:
    let extraWildcards = wildcardCount - gaps;

    // Where do extra wildcards go? Standard 101 usually expects they replace specific tiles.
    // However, if the user sends 4 tiles [10, 11, 12, Joker], the Joker is 13.
    // If [Joker, 10, 11, 12], the Joker is 9.

    // IN FRONTEND, the user usually arranges them. But here we just have an array.
    // Let's assume the wildcards are placed to extend the sequence.
    // If gaps are filled, we have a solid block of maxNum - minNum + 1 tiles.
    // The score for this block is sum of numbers from minNum to maxNum.
    let currentScore = 0;
    for (let j = minNum; j <= maxNum; j++) currentScore += j;

    // For extra wildcards, we add them at the end (or start if end hits 13).
    let high = maxNum;
    let low = minNum;

    while (extraWildcards > 0) {
        if (high < 13) {
            high++;
            currentScore += high;
        } else if (low > 1) {
            low--;
            currentScore += low;
        } else {
            // Can't extend anymore? Invalid sequence
            return { isValid: false, score: 0 };
        }
        extraWildcards--;
    }

    return { isValid: true, score: currentScore };
}
export function calculateMultipleSetsScore(sets: Tile[][], okeyTile: Tile): { isValid: boolean, totalScore: number } {
    let totalScore = 0;
    for (const set of sets) {
        const res = calculateSetScore(set, okeyTile);
        if (!res.isValid) return { isValid: false, totalScore: 0 };
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
        const isOkey = t.isJoker || (okeyTile && t.color === okeyTile.color && t.number === okeyTile.number);
        if (isOkey) {
            total += 101;
        } else {
            total += t.number;
        }
    });
    return total;
}
export function canAddTileToSet(existingSet: Tile[], newTile: Tile, okeyTile: Tile): { isValid: boolean, newSet: Tile[] } {
    // Try to create a valid set with the new tile
    const combined = [...existingSet, newTile];
    const res = calculateSetScore(combined, okeyTile);
    return { isValid: res.isValid, newSet: combined };
}
