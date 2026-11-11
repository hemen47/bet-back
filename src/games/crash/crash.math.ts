import { createHmac } from 'node:crypto';

/**
 * Crash rules and math. Pure functions only, no I/O.
 *
 * Multipliers are integers in hundredths (250 = 2.50×) and time is whole
 * milliseconds since the round started, so the server, the tests and the
 * client all compute exactly the same numbers.
 *
 * ── Growth ────────────────────────────────────────────────────────────
 *   m(t) = floor(100 · e^(GROWTH · t)) / 100        t in ms
 *   2× after ~11.6 s, 10× after ~38 s, 100× after ~77 s.
 *
 * ── Crash point ───────────────────────────────────────────────────────
 *   r  = first 52 bits of HMAC_SHA256(serverSeed, clientSeed) / 2^52   ∈ [0, 1)
 *   cp = floor((100 - edge) / (1 - r))  hundredths, clamped to [1.00×, 1000×]
 *
 * For any target x ≥ 1.01×: P(cp ≥ x) = (1 - edge) / x, so cashing out at
 * x returns (1 - edge) in expectation, whatever the strategy. A raw value
 * below 1.00× (probability = edge) crashes instantly.
 *
 * ── Rules ─────────────────────────────────────────────────────────────
 *   The round has crashed at time t when m(t) ≥ cp.
 *   A cash-out at time t is valid only while m(t) < cp, and pays m(t).
 *   An auto cash-out target a < cp pays exactly a, when m(t) first reaches a.
 */
export const CRASH_BET_OPTIONS = [10, 50, 100] as const;
export type CrashBetOption = (typeof CRASH_BET_OPTIONS)[number];

export const CRASH_HOUSE_EDGE_PERCENT = 5;
export const GROWTH_PER_MS = 0.00006;
/** Hard cap: the round ends at 1000× at the latest (~115 s). */
export const MAX_CRASH_X100 = 100_000;
/** "Waiting" phase between the bet and lift-off. */
export const START_DELAY_MS = 1500;
export const AUTO_CASHOUT_MIN_X100 = 101;
export const AUTO_CASHOUT_MAX_X100 = MAX_CRASH_X100;

/** Multiplier in hundredths `elapsedMs` after lift-off (100 before it). */
export function multiplierAtX100(elapsedMs: number): number {
  if (elapsedMs <= 0) return 100;
  return Math.floor(100 * Math.exp(GROWTH_PER_MS * Math.floor(elapsedMs)));
}

/** The first whole millisecond at which the multiplier reaches `x100`. */
export function msToReach(x100: number): number {
  if (x100 <= 100) return 0;
  // Analytic estimate, then step to the exact integer boundary.
  let ms = Math.max(0, Math.floor(Math.log(x100 / 100) / GROWTH_PER_MS) - 2);
  while (multiplierAtX100(ms) < x100) ms++;
  return ms;
}

/** Uniform float in [0, 1) from the first 52 bits of the HMAC. */
export function crashFloat(serverSeed: string, clientSeed: string): number {
  const h = createHmac('sha256', serverSeed).update(clientSeed).digest();
  const high48 = h.readUIntBE(0, 6);
  const low4 = h[6] >> 4;
  return (high48 * 16 + low4) / 2 ** 52;
}

/** The round's crash point in hundredths (100 = instant crash). */
export function crashPointX100(serverSeed: string, clientSeed: string): number {
  const r = crashFloat(serverSeed, clientSeed);
  const raw = Math.floor((100 - CRASH_HOUSE_EDGE_PERCENT) / (1 - r));
  return Math.min(MAX_CRASH_X100, Math.max(100, raw));
}

export type CrashOutcome =
  | { kind: 'running' }
  | { kind: 'auto_cashout'; x100: number }
  | { kind: 'crashed' };

/**
 * What has happened by `elapsedMs` after lift-off, before any manual action.
 * An auto cash-out below the crash point wins, even when both land in the
 * same millisecond.
 */
export function outcomeAt(
  elapsedMs: number,
  crashX100: number,
  autoX100: number | null | undefined,
): CrashOutcome {
  if (autoX100 && autoX100 < crashX100 && elapsedMs >= msToReach(autoX100)) {
    return { kind: 'auto_cashout', x100: autoX100 };
  }
  if (elapsedMs >= msToReach(crashX100)) return { kind: 'crashed' };
  return { kind: 'running' };
}

/** Milliseconds after lift-off of the next automatic event (auto cash-out or crash). */
export function nextEventMs(
  crashX100: number,
  autoX100: number | null | undefined,
): number {
  const crash = msToReach(crashX100);
  return autoX100 && autoX100 < crashX100
    ? Math.min(crash, msToReach(autoX100))
    : crash;
}

/** Payout in units for a bet in units at a multiplier in hundredths. Floors. */
export function crashPayoutUnits(betUnits: number, x100: number): number {
  return Math.floor((betUnits * x100) / 100);
}
