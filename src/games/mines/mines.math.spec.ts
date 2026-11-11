import {
  multiplierTable,
  multiplierX100,
  payoutUnits,
  survivalProbability,
} from './mines.math.js';

describe('mines math (3×3, 2 bombs, 5% edge)', () => {
  it('pays 0.95 / P(k), floored to 2 decimals', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((k) => multiplierX100(k))).toEqual([
      122, 162, 228, 342, 570, 1140, 3420,
    ]);
  });

  it('starts at 1.00× and rejects impossible steps', () => {
    expect(multiplierX100(0)).toBe(100);
    expect(() => multiplierX100(8)).toThrow(RangeError);
    expect(() => multiplierX100(-1)).toThrow(RangeError);
  });

  it('never returns more than 95% to the player at any cash-out point', () => {
    for (let k = 1; k <= 7; k++) {
      const rtp = (multiplierX100(k) / 100) * survivalProbability(k);
      expect(rtp).toBeLessThanOrEqual(0.95 + 1e-12);
      expect(rtp).toBeGreaterThan(0.94);
    }
  });

  it('computes exact integer payouts', () => {
    expect(payoutUnits(1000, 122)).toBe(1220); // 10 coins × 1.22
    expect(payoutUnits(10000, 3420)).toBe(342000); // 100 coins × 34.20
  });

  it('exposes a table for the UI', () => {
    expect(multiplierTable()).toHaveLength(7);
    expect(multiplierTable()[0]).toMatchObject({
      safeRevealed: 1,
      multiplier: 1.22,
    });
  });
});
