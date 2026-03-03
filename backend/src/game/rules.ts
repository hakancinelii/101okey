// src/game/rules.ts
/**
 * 101 Okey – Game rule engine
 *  - validateSet   : three identical tiles (same color & number) or using jokers.
 *  - validateSequence : same color, consecutive numbers (e.g., 7‑8‑9) with optional jokers.
 *  - isValidTile   : helper to check tile shape.
 */

export type Color = 'red' | 'yellow' | 'blue' | 'black' | 'fake';

export interface Tile {
    id: string;
    color: Color;
    number: number; // 1-13 (0 for fake joker)
    isJoker?: boolean;
    isFakeJoker?: boolean;
}

/**
 * Validate a set (three identical tiles).
 * Rules:
 *   - All three tiles must have same color and number.
 *   - Jokers can replace any tile. If a real joker is present, it can stand for any missing tile.
 *   - Fake joker behaves like its original number/color.
 */
export function validateSet(tiles: Tile[]): boolean {
    if (tiles.length !== 3) return false;
    // Normalise fake jokers to their underlying value
    const normalized = tiles.map((t) => {
        if (t.isFakeJoker) return { color: t.color, number: t.number, isJoker: false };
        return t;
    });

    // Count real jokers
    const realJokers = normalized.filter((t) => t.isJoker).length;
    const nonJokers = normalized.filter((t) => !t.isJoker);

    if (nonJokers.length === 0) return true; // all jokers – technically a set

    const first = nonJokers[0];
    // All non‑joker tiles must match first's color & number
    const allMatch = nonJokers.every((t) => t.color === first.color && t.number === first.number);
    if (!allMatch) return false;

    // Real jokers can fill missing slots, so any count is fine as long as non‑jokers match
    return true;
}

/**
 * Validate a sequence (minimum 3 consecutive tiles of same color).
 * Rules:
 *   - Tiles must be sorted by number.
 *   - Gaps can be filled by real jokers.
 *   - Fake jokers count as their original number.
 */
export function validateSequence(tiles: Tile[]): boolean {
    if (tiles.length < 3) return false;

    // Normalise fake jokers
    const normalized = tiles.map((t) => {
        if (t.isFakeJoker) return { color: t.color, number: t.number, isJoker: false };
        return t;
    });

    // Separate real jokers
    const realJokers = normalized.filter((t) => t.isJoker).length;
    const nonJokers = normalized.filter((t) => !t.isJoker);

    if (nonJokers.length === 0) return true; // all jokers can form any sequence

    // All non‑joker tiles must share the same color
    const color = nonJokers[0].color;
    if (!nonJokers.every((t) => t.color === color)) return false;

    // Sort numbers
    const numbers = nonJokers.map((t) => t.number).sort((a, b) => a - b);

    // Check gaps
    let gaps = 0;
    for (let i = 1; i < numbers.length; i++) {
        const diff = numbers[i] - numbers[i - 1];
        if (diff === 0) return false; // duplicate numbers not allowed in a sequence
        if (diff > 1) gaps += diff - 1; // missing numbers between tiles
    }

    // Real jokers can fill the gaps
    return realJokers >= gaps;
}

/**
 * Helper to check a tile's basic validity (color & number range).
 */
export function isValidTile(tile: Tile): boolean {
    const colors: Color[] = ['red', 'yellow', 'blue', 'black'];
    if (!colors.includes(tile.color)) return false;
    if (tile.number < 1 || tile.number > 13) return false;
    return true;
}
