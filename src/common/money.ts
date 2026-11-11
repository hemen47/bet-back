/**
 * Coins are shown with up to 2 decimals (payouts like 10 × 1.22 = 12.20),
 * but are stored and computed as integer "units" (1 coin = 100 units) so
 * that no floating-point error can ever reach a balance.
 */
export const UNITS_PER_COIN = 100;

export function coinsToUnits(coins: number): number {
  return Math.round(coins * UNITS_PER_COIN);
}

export function unitsToCoins(units: number): number {
  return units / UNITS_PER_COIN;
}
