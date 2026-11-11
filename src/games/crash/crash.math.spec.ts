import { randomBytes } from 'node:crypto';
import {
  crashPayoutUnits,
  crashPointX100,
  MAX_CRASH_X100,
  msToReach,
  multiplierAtX100,
  nextEventMs,
  outcomeAt,
} from './crash.math.js';

describe('crash math', () => {
  it('starts at 1.00× and grows: ~2× at 11.6 s, ~10× at 38 s', () => {
    expect(multiplierAtX100(-500)).toBe(100);
    expect(multiplierAtX100(0)).toBe(100);
    expect(multiplierAtX100(11_552)).toBe(199);
    expect(multiplierAtX100(11_553)).toBe(200);
    expect(multiplierAtX100(38_376)).toBeGreaterThanOrEqual(999);
  });

  it('msToReach is the exact first millisecond a multiplier is reached', () => {
    for (const x of [101, 150, 200, 250, 1000, 5000, MAX_CRASH_X100]) {
      const ms = msToReach(x);
      expect(multiplierAtX100(ms)).toBeGreaterThanOrEqual(x);
      expect(multiplierAtX100(ms - 1)).toBeLessThan(x);
    }
    expect(msToReach(100)).toBe(0);
  });

  it('derives the crash point deterministically from the seeds, within bounds', () => {
    const a = crashPointX100('a'.repeat(64), 'client');
    expect(crashPointX100('a'.repeat(64), 'client')).toBe(a);
    expect(crashPointX100('a'.repeat(64), 'other')).not.toBe(a);
    for (let i = 0; i < 2000; i++) {
      const cp = crashPointX100(randomBytes(32).toString('hex'), 'c');
      expect(cp).toBeGreaterThanOrEqual(100);
      expect(cp).toBeLessThanOrEqual(MAX_CRASH_X100);
    }
  });

  it('returns ~95% for any fixed cash-out target (5% house edge)', () => {
    const n = 200_000;
    const points = Array.from({ length: n }, (_, i) =>
      crashPointX100(randomBytes(32).toString('hex'), `c${i}`),
    );
    for (const target of [150, 200, 500]) {
      const wins = points.filter((cp) => cp > target).length;
      const rtp = (wins * target) / 100 / n;
      expect(rtp).toBeGreaterThan(0.93);
      expect(rtp).toBeLessThan(0.97);
    }
    // ~5% of rounds crash instantly at 1.00×.
    const instant = points.filter((cp) => cp === 100).length / n;
    expect(instant).toBeGreaterThan(0.04);
    expect(instant).toBeLessThan(0.06);
  });

  it('decides crash vs auto cash-out by time, auto winning only below the crash point', () => {
    const crash = 300;
    expect(outcomeAt(msToReach(299), crash, null)).toEqual({ kind: 'running' });
    expect(outcomeAt(msToReach(300), crash, null)).toEqual({ kind: 'crashed' });
    expect(outcomeAt(msToReach(200), crash, 200)).toEqual({ kind: 'auto_cashout', x100: 200 });
    expect(outcomeAt(msToReach(200) - 1, crash, 200)).toEqual({ kind: 'running' });
    // Target at or above the crash point never pays.
    expect(outcomeAt(msToReach(300), crash, 300)).toEqual({ kind: 'crashed' });
    expect(outcomeAt(msToReach(300), crash, 500)).toEqual({ kind: 'crashed' });
    // Instant crash.
    expect(outcomeAt(0, 100, 101)).toEqual({ kind: 'crashed' });
    expect(nextEventMs(300, 200)).toBe(msToReach(200));
    expect(nextEventMs(300, 400)).toBe(msToReach(300));
  });

  it('pays bet × multiplier, floored to units (task example: 100 at 2.50× = 250)', () => {
    expect(crashPayoutUnits(10_000, 250)).toBe(25_000);
    expect(crashPayoutUnits(1_000, 133)).toBe(1_330);
    expect(crashPayoutUnits(5_000, 101)).toBe(5_050);
  });
});
