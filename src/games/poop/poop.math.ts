import { createHmac } from 'node:crypto';

/**
 * Poop rules. Pure functions only, no I/O.
 *
 * Up to 5 stages. At each stage exactly one of 💩 `poop` / 😆 `laugh` is
 * correct, 50/50 and independent of other stages. A correct pick raises the
 * multiplier; a wrong pick ends the round and loses the bet.
 *
 * Multipliers are the task's fixed table: 0.95 × 2^k after k correct picks
 * (a 5% house edge on the probability 0.5^k of getting there).
 */
export const POOP_BET_OPTIONS = [10, 50, 100] as const;
export const POOP_CHOICES = ['poop', 'laugh'] as const;
export type PoopChoice = (typeof POOP_CHOICES)[number];

export const POOP_STAGES = 5;
/** Multiplier in hundredths after stage k (index k - 1): 1.90×, 3.80×, 7.60×, 15.20×, 30.40×. */
export const POOP_MULTIPLIERS_X100 = [190, 380, 760, 1520, 3040] as const;
export const POOP_HOUSE_EDGE_PERCENT = 5;

/** Multiplier in hundredths after `completed` correct picks (100 before the first). */
export function poopMultiplierX100(completed: number): number {
  if (!Number.isInteger(completed) || completed < 0 || completed > POOP_STAGES) {
    throw new RangeError(`completed must be 0..${POOP_STAGES}`);
  }
  return completed === 0 ? 100 : POOP_MULTIPLIERS_X100[completed - 1];
}

/**
 * The correct answer for stage `stage` (1-based): the low bit of
 * HMAC_SHA256(serverSeed, `${clientSeed}:${stage}`). One independent fair
 * coin per stage, all fixed when the round starts.
 */
export function stageAnswer(serverSeed: string, clientSeed: string, stage: number): PoopChoice {
  const byte = createHmac('sha256', serverSeed).update(`${clientSeed}:${stage}`).digest()[0];
  return byte & 1 ? 'laugh' : 'poop';
}

export function roundAnswers(serverSeed: string, clientSeed: string): PoopChoice[] {
  return Array.from({ length: POOP_STAGES }, (_, i) => stageAnswer(serverSeed, clientSeed, i + 1));
}

/** Payout in units for a bet in units at a multiplier in hundredths. Floors. */
export function poopPayoutUnits(betUnits: number, x100: number): number {
  return Math.floor((betUnits * x100) / 100);
}

/** Table for the UI. */
export function poopTable() {
  return POOP_MULTIPLIERS_X100.map((x100, i) => ({
    stage: i + 1,
    multiplier: x100 / 100,
    probability: 0.5 ** (i + 1),
  }));
}
