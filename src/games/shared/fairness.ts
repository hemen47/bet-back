import { createHash, randomBytes } from 'node:crypto';

/**
 * Commit/reveal seeds shared by every provably fair game.
 *
 * Before a round, the server commits to a secret `serverSeed` by publishing
 * `sha256(serverSeed)`. The outcome is then derived from
 * HMAC_SHA256(serverSeed, clientSeed…), and the seed is revealed once the
 * round is over, so anyone can check the commitment and recompute the result.
 */
export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function generateClientSeed(): string {
  return randomBytes(12).toString('hex');
}

export function hashServerSeed(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}
