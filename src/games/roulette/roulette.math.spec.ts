import { randomBytes } from 'node:crypto';
import {
  betPayoutUnits,
  colorOf,
  coveredNumbers,
  isWinning,
  payoutMultiplier,
  spinNumber,
  WHEEL_ORDER,
} from './roulette.math.js';

const ALL_TARGETS = [
  ...Array.from({ length: 37 }, (_, n) => `straight:${n}`),
  'red', 'black', 'even', 'odd', 'low', 'high',
  'dozen:1', 'dozen:2', 'dozen:3', 'column:1', 'column:2', 'column:3',
];

describe('roulette math', () => {
  it('has a standard European wheel: 0 green, 18 red, 18 black, each number once', () => {
    expect([...WHEEL_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
    const colors = Array.from({ length: 37 }, (_, n) => colorOf(n));
    expect(colors.filter((c) => c === 'green')).toHaveLength(1);
    expect(colors.filter((c) => c === 'red')).toHaveLength(18);
    expect(colors.filter((c) => c === 'black')).toHaveLength(18);
    // Neighbours on the wheel alternate red/black.
    for (let i = 1; i < WHEEL_ORDER.length - 1; i++) {
      expect(colorOf(WHEEL_ORDER[i])).not.toBe(colorOf(WHEEL_ORDER[i + 1]));
    }
  });

  it('pays the required multipliers: ×2 for red/black and even/odd, ×36 straight, ×3 dozens/columns', () => {
    expect(payoutMultiplier('red')).toBe(2);
    expect(payoutMultiplier('black')).toBe(2);
    expect(payoutMultiplier('even')).toBe(2);
    expect(payoutMultiplier('odd')).toBe(2);
    expect(payoutMultiplier('low')).toBe(2);
    expect(payoutMultiplier('straight:17')).toBe(36);
    expect(payoutMultiplier('straight:0')).toBe(36);
    expect(payoutMultiplier('dozen:2')).toBe(3);
    expect(payoutMultiplier('column:3')).toBe(3);
  });

  it('treats 0 as a loss for every outside bet, and a win for straight:0 only', () => {
    for (const t of ALL_TARGETS) {
      expect(isWinning(t, 0)).toBe(t === 'straight:0');
    }
  });

  it('covers the right numbers', () => {
    expect(coveredNumbers('dozen:2')).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(coveredNumbers('column:1')).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
    expect(coveredNumbers('high')[0]).toBe(19);
    expect(isWinning('red', 1)).toBe(true);
    expect(isWinning('black', 2)).toBe(true);
    expect(isWinning('even', 36)).toBe(true);
    expect(() => coveredNumbers('straight:37')).toThrow();
    expect(() => coveredNumbers('split:1-2')).toThrow();
  });

  it('returns exactly 36/37 of the stake for every bet type (2.70% edge)', () => {
    for (const t of ALL_TARGETS) {
      let returned = 0;
      for (let n = 0; n <= 36; n++) returned += betPayoutUnits(t, 100, n);
      expect(returned / 37 / 100).toBeCloseTo(36 / 37, 10);
    }
  });

  it('matches the task example: 100 on red, red wins, pays 200', () => {
    expect(betPayoutUnits('red', 10_000, 32)).toBe(20_000);
    expect(betPayoutUnits('red', 10_000, 15)).toBe(0);
  });

  it('draws numbers deterministically and uniformly from the seeds', () => {
    expect(spinNumber('a'.repeat(64), 'x')).toBe(spinNumber('a'.repeat(64), 'x'));
    const counts: number[] = Array.from({ length: 37 }, () => 0);
    const n = 74_000;
    for (let i = 0; i < n; i++) counts[spinNumber(randomBytes(32).toString('hex'), `c${i}`)]++;
    // Expected 2000 per pocket; chi-square with 36 dof stays well under 80.
    const chi = counts.reduce((sum, c) => sum + (c - n / 37) ** 2 / (n / 37), 0);
    expect(chi).toBeLessThan(80);
  });
});
