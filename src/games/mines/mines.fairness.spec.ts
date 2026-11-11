import { bombPositions, hashServerSeed } from './mines.fairness.js';

describe('mines fairness', () => {
  const serverSeed = 'a'.repeat(64);

  it('is deterministic for a seed pair', () => {
    const a = bombPositions(serverSeed, 'client', 9, 2);
    expect(bombPositions(serverSeed, 'client', 9, 2)).toEqual(a);
    expect(a).toHaveLength(2);
    expect(new Set(a).size).toBe(2);
    a.forEach((tile) => expect(tile).toBeGreaterThanOrEqual(0));
    a.forEach((tile) => expect(tile).toBeLessThan(9));
  });

  it('changes with the client seed', () => {
    const boards = new Set(
      Array.from({ length: 50 }, (_, i) =>
        bombPositions(serverSeed, `c${i}`, 9, 2).join(','),
      ),
    );
    expect(boards.size).toBeGreaterThan(10);
  });

  it('places bombs roughly uniformly', () => {
    const counts = Array.from({ length: 9 }, () => 0);
    const rounds = 9000;
    for (let i = 0; i < rounds; i++) {
      for (const tile of bombPositions(serverSeed, `n${i}`, 9, 2))
        counts[tile]++;
    }
    const expected = (rounds * 2) / 9; // 2000
    counts.forEach((c) =>
      expect(Math.abs(c - expected)).toBeLessThan(expected * 0.1),
    );
  });

  it('hashes the server seed with sha256', () => {
    expect(hashServerSeed('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
