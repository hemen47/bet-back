import { createHmac } from 'node:crypto';

/**
 * European roulette rules. Pure functions only, no I/O.
 *
 * One zero, numbers 0..36. A bet pays its total multiplier (stake included)
 * when it wins and nothing otherwise; 0 loses every outside bet.
 *
 *   straight:N   ×36   (N = 0..36)
 *   red, black   ×2
 *   even, odd    ×2
 *   low (1-18), high (19-36)  ×2
 *   dozen:1..3   ×3    (1-12, 13-24, 25-36)
 *   column:1..3  ×3    (column k = numbers with n % 3 == k % 3, i.e. 1,4,…34 / 2,5,…35 / 3,6,…36)
 *
 * Every bet covers k numbers and pays 36/k, so each returns 36/37 of the
 * stake on average: a 2.70% house edge, the standard for European roulette.
 */
export const ROULETTE_CHIPS = [10, 50, 100] as const;
/** Upper bound for one spin, all bets together (coins). */
export const MAX_TOTAL_BET = 1000;
/** Upper bound for distinct bets in one spin. */
export const MAX_BETS = 40;

export const POCKETS = 37;
export const RED_NUMBERS = [
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
] as const;
/** Pocket order on a European wheel, clockwise from 0. */
export const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;

export type PocketColor = 'green' | 'red' | 'black';
const RED = new Set<number>(RED_NUMBERS);

export function colorOf(n: number): PocketColor {
  if (n === 0) return 'green';
  return RED.has(n) ? 'red' : 'black';
}

/** `straight:0`…`straight:36`, `red` … `high`, `dozen:1`…`3`, `column:1`…`3`. */
export const BET_TARGET_PATTERN =
  /^(straight:(?:[0-9]|[12][0-9]|3[0-6])|red|black|even|odd|low|high|dozen:[1-3]|column:[1-3])$/;

/** The numbers a bet target covers. Throws on an unknown target. */
export function coveredNumbers(target: string): number[] {
  if (!BET_TARGET_PATTERN.test(target)) {
    throw new RangeError(`unknown bet target: ${target}`);
  }
  const [kind, raw] = target.split(':');
  const value = Number(raw);
  const all = Array.from({ length: 36 }, (_, i) => i + 1);
  switch (kind) {
    case 'straight':
      return [value];
    case 'red':
      return all.filter((n) => RED.has(n));
    case 'black':
      return all.filter((n) => !RED.has(n));
    case 'even':
      return all.filter((n) => n % 2 === 0);
    case 'odd':
      return all.filter((n) => n % 2 === 1);
    case 'low':
      return all.filter((n) => n <= 18);
    case 'high':
      return all.filter((n) => n >= 19);
    case 'dozen':
      return all.filter((n) => Math.ceil(n / 12) === value);
    case 'column':
      return all.filter((n) => ((n - 1) % 3) + 1 === value);
    default:
      throw new RangeError(`unknown bet target: ${target}`);
  }
}

/** Total return multiplier when the bet wins (stake included): 36 / numbers covered. */
export function payoutMultiplier(target: string): number {
  return 36 / coveredNumbers(target).length;
}

export function isWinning(target: string, n: number): boolean {
  return coveredNumbers(target).includes(n);
}

/** Payout in units for one bet (0 if it loses). Always an integer. */
export function betPayoutUnits(target: string, amountUnits: number, n: number): number {
  return isWinning(target, n) ? amountUnits * payoutMultiplier(target) : 0;
}

/**
 * Provably fair winning number: rejection-sampled from 4-byte chunks of
 * HMAC_SHA256(serverSeed, `${clientSeed}:${round}`), so every pocket has
 * exactly 1/37 chance (no modulo bias).
 */
export function spinNumber(serverSeed: string, clientSeed: string): number {
  const limit = Math.floor(2 ** 32 / POCKETS) * POCKETS;
  for (let round = 0; ; round++) {
    const bytes = createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${round}`)
      .digest();
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
      const value = bytes.readUInt32BE(offset);
      if (value < limit) return value % POCKETS;
    }
  }
}

/** Table of bet kinds for the UI. */
export function payoutTable() {
  return [
    { bet: 'Straight (single number)', example: 'straight:17', multiplier: 36 },
    { bet: 'Red / Black', example: 'red', multiplier: 2 },
    { bet: 'Even / Odd', example: 'even', multiplier: 2 },
    { bet: '1-18 / 19-36', example: 'low', multiplier: 2 },
    { bet: 'Dozen', example: 'dozen:1', multiplier: 3 },
    { bet: 'Column (2 to 1)', example: 'column:1', multiplier: 3 },
  ];
}
