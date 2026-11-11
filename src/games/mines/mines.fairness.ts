import { createHmac } from 'node:crypto';

/**
 * Provably fair bomb placement.
 *
 * 1. Before a game, the server commits to a secret `serverSeed` by
 *    publishing `sha256(serverSeed)` (GET /games/mines/fairness).
 * 2. The player starts a game with any `clientSeed` (or a random one).
 *    The server can't pick a seed to suit it: the hash was published first.
 * 3. Bombs = bombPositions(serverSeed, clientSeed). They are fixed at start
 *    and stored server-side. The client never sees them during play.
 * 4. When the game ends, `serverSeed` is revealed. Anyone can check that
 *    sha256(serverSeed) matches the commitment and recompute the bombs.
 *
 * Positions come from a Fisher–Yates draw driven by
 * HMAC_SHA256(key = serverSeed, msg = `${clientSeed}:${round}`), 4 bytes per draw.
 */
export {
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
} from '../shared/fairness.js';

function* uniformFloats(serverSeed: string, clientSeed: string) {
  for (let round = 0; ; round++) {
    const bytes = createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${round}`)
      .digest();
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
      yield bytes.readUInt32BE(offset) / 2 ** 32;
    }
  }
}

/** Sorted tile indices (0-based, row-major) that hold a bomb. */
export function bombPositions(
  serverSeed: string,
  clientSeed: string,
  tiles: number,
  mines: number,
): number[] {
  const deck = Array.from({ length: tiles }, (_, i) => i);
  const floats = uniformFloats(serverSeed, clientSeed);
  const bombs: number[] = [];
  for (let i = 0; i < mines; i++) {
    const r = floats.next().value as number;
    const index = Math.floor(r * deck.length);
    bombs.push(deck.splice(index, 1)[0]);
  }
  return bombs.sort((a, b) => a - b);
}
