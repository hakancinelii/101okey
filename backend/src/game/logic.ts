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

    // Resolve Okeys and Fake Jokers values for the set
    // In 101, Okey tile (matching color/num of indicator+1) is a wildcard.
    // Fake Joker tiles take the value of that Okey tile.
    const resolvedTiles = tiles.map(t => {
        const isOkey = t.isJoker || (okeyTile && t.color === okeyTile.color && t.number === okeyTile.number);
        if (isOkey) return { ...t, isWildcard: true };
        if (t.isFakeJoker) return { ...t, color: okeyTile.color, number: okeyTile.number };
        return t;
    });

    const isGroup = isValidGroup(resolvedTiles);
    const isSeq = isValidSequence(resolvedTiles);

    if (!isGroup && !isSeq) return { isValid: false, score: 0 };

    // Total score is sum of numbers
    // For wildcard tiles, we need to infer their value based on position
    let totalScore = 0;
    if (isGroup) {
        // In a group, all tiles have the same number
        const baseNum = resolvedTiles.find(t => !(t as any).isWildcard)?.number || okeyTile.number;
        totalScore = baseNum * resolvedTiles.length;
    } else {
        // In a sequence, numbers are consecutive
        // Find a concrete tile to start from
        const concreteIdx = resolvedTiles.findIndex(t => !(t as any).isWildcard);
        if (concreteIdx === -1) {
            // All okeys? Unlikely but let's handle
            return { isValid: false, score: 0 };
        }
        const baseNum = resolvedTiles[concreteIdx].number;
        // Calculate the value of each tile position
        resolvedTiles.forEach((t, i) => {
            let val = baseNum - (concreteIdx - i);
            if (val <= 0) val = 13 + val; // wrap around for 1-2-3 (if we allowed it at start, usually 12-13-1)
            if (val > 13) val = val % 13;
            totalScore += val;
        });
    }

    return { isValid: true, score: totalScore };
}

function isValidGroup(tiles: any[]): boolean {
    if (tiles.length < 3 || tiles.length > 4) return false;
    const baseNum = tiles.find(t => !t.isWildcard)?.number;
    if (!baseNum) return true; // all wildcards?

    const colors = new Set();
    for (const t of tiles) {
        if (!t.isWildcard && t.number !== baseNum) return false;
        if (!t.isWildcard) {
            if (colors.has(t.color)) return false; // same color not allowed in group
            colors.add(t.color);
        }
    }
    return true;
}

function isValidSequence(tiles: any[]): boolean {
    if (tiles.length < 3) return false;
    const color = tiles.find(t => !t.isWildcard)?.color;
    if (!color) return true;

    // Check color and consecutiveness
    for (let i = 0; i < tiles.length; i++) {
        if (!tiles[i].isWildcard && tiles[i].color !== color) return false;
    }

    // Check numbers
    const concreteIdx = tiles.findIndex(t => !t.isWildcard);
    const baseNum = tiles[concreteIdx].number;

    for (let i = 0; i < tiles.length; i++) {
        if (tiles[i].isWildcard) continue;
        let expected = baseNum - (concreteIdx - i);
        // handle wrap 12-13-1
        if (expected <= 0) expected = 13 + expected;
        if (expected > 13) expected = expected % 13;
        if (tiles[i].number !== expected) return false;
    }

    return true;
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
