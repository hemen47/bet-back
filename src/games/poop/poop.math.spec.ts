import { randomBytes } from 'node:crypto';
import {
  poopMultiplierX100,
  poopPayoutUnits,
  POOP_MULTIPLIERS_X100,
  roundAnswers,
  stageAnswer,
} from './poop.math.js';

describe('poop math', () => {
  it('uses the task multiplier table: 1.90, 3.80, 7.60, 15.20, 30.40', () => {
    expect([...POOP_MULTIPLIERS_X100]).toEqual([190, 380, 760, 1520, 3040]);
    expect(poopMultiplierX100(0)).toBe(100);
    expect(poopMultiplierX100(2)).toBe(380);
    expect(() => poopMultiplierX100(6)).toThrow();
  });

  it('is 0.95 × the fair odds at every stage (5% house edge)', () => {
    POOP_MULTIPLIERS_X100.forEach((x100, i) => {
      const fair = 2 ** (i + 1);
      expect(x100 / 100 / fair).toBeCloseTo(0.95, 10);
    });
  });

  it('matches the task example: 100 × 3.80 = 380', () => {
    expect(poopPayoutUnits(10_000, 380)).toBe(38_000);
  });

  it('derives 5 deterministic answers per round, ~50/50 and independent', () => {
    const seed = 'c'.repeat(64);
    expect(roundAnswers(seed, 'x')).toEqual(roundAnswers(seed, 'x'));
    expect(roundAnswers(seed, 'x')).toHaveLength(5);

    let poop = 0;
    let same = 0;
    const n = 40_000;
    for (let i = 0; i < n; i++) {
      const s = randomBytes(32).toString('hex');
      const a = stageAnswer(s, 'c', 1);
      const b = stageAnswer(s, 'c', 2);
      if (a === 'poop') poop++;
      if (a === b) same++;
    }
    expect(poop / n).toBeGreaterThan(0.48);
    expect(poop / n).toBeLessThan(0.52);
    // Independent stages: stage 2 matches stage 1 half of the time.
    expect(same / n).toBeGreaterThan(0.48);
    expect(same / n).toBeLessThan(0.52);
  });
});
