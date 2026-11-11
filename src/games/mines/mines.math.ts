/**
 * Mines rules and payout math. Pure functions only, no I/O.
 *
 * A board has `tiles` cells of which `mines` hide a bomb. After `k` safe
 * reveals, the probability of having survived is
 *
 *   P(k) = C(safe, k) / C(tiles, k) = Π_{i=0..k-1} (safe - i) / (tiles - i)
 *
 * A fair game would pay 1 / P(k). We pay (1 - edge) / P(k), floored to
 * 2 decimals, so the house keeps `edge` of every bet in expectation.
 *
 * Multipliers are kept as integers in hundredths (122 = 1.22×) so payouts
 * are exact integer arithmetic.
 */
export const MINES_TILES = 9; // 3×3 grid
export const MINES_COUNT = 2;
export const SAFE_TILES = MINES_TILES - MINES_COUNT;
export const HOUSE_EDGE_PERCENT = 5;
export const BET_OPTIONS = [10, 50, 100] as const;
export type BetOption = (typeof BET_OPTIONS)[number];

/** Multiplier in hundredths after `safeRevealed` safe tiles. 0 reveals = 100 (1.00×). */
export function multiplierX100(
  safeRevealed: number,
  tiles = MINES_TILES,
  mines = MINES_COUNT,
  edgePercent = HOUSE_EDGE_PERCENT,
): number {
  const safe = tiles - mines;
  if (
    !Number.isInteger(safeRevealed) ||
    safeRevealed < 0 ||
    safeRevealed > safe
  ) {
    throw new RangeError(`safeRevealed must be 0..${safe}`);
  }
  if (safeRevealed === 0) return 100;

  // 1/P(k) = Π (tiles - i) / (safe - i): integers, exact for these sizes.
  let numerator = 1;
  let denominator = 1;
  for (let i = 0; i < safeRevealed; i++) {
    numerator *= tiles - i;
    denominator *= safe - i;
  }
  return Math.floor(((100 - edgePercent) * numerator) / denominator);
}

/** Survival probability after `safeRevealed` safe tiles. */
export function survivalProbability(
  safeRevealed: number,
  tiles = MINES_TILES,
  mines = MINES_COUNT,
): number {
  const safe = tiles - mines;
  let p = 1;
  for (let i = 0; i < safeRevealed; i++) p *= (safe - i) / (tiles - i);
  return p;
}

/** Payout in units for a bet in units at a multiplier in hundredths. Floors. */
export function payoutUnits(betUnits: number, multX100: number): number {
  return Math.floor((betUnits * multX100) / 100);
}

/** Full table for the UI: step k → multiplier and chance. */
export function multiplierTable(
  tiles = MINES_TILES,
  mines = MINES_COUNT,
): { safeRevealed: number; multiplier: number; probability: number }[] {
  return Array.from({ length: tiles - mines }, (_, i) => ({
    safeRevealed: i + 1,
    multiplier: multiplierX100(i + 1, tiles, mines) / 100,
    probability: survivalProbability(i + 1, tiles, mines),
  }));
}
