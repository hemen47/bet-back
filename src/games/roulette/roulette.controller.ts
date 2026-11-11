import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { hashServerSeed } from '../shared/fairness.js';
import { colorOf, MAX_BETS, spinNumber } from './roulette.math.js';
import { RouletteService } from './roulette.service.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/, 'invalid id');

const spinBody = z.object({
  /** Client-generated id (UUID) for this Spin press. Retrying with the same id never charges twice. */
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, '8-64 chars of A-Z a-z 0-9 _ -'),
  bets: z
    .array(
      z.object({
        target: z.string().max(16),
        amount: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(MAX_BETS * 4),
  clientSeed: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, '1-64 chars of A-Z a-z 0-9 _ -')
    .optional(),
});

const verifyQuery = z.object({
  serverSeed: z.string().regex(/^[0-9a-f]{64}$/),
  clientSeed: z.string().min(1).max(64),
});

@Controller('games/roulette')
export class RouletteController {
  constructor(private readonly roulette: RouletteService) {}

  /** Chips, limits, wheel order, red numbers and the payout table. */
  @Public()
  @Get('config')
  config() {
    return this.roulette.getConfig();
  }

  /** Recomputes a spin's winning number from its seeds. */
  @Public()
  @Get('verify')
  verify(@Query({ schema: verifyQuery }) q: z.infer<typeof verifyQuery>) {
    const number = spinNumber(q.serverSeed, q.clientSeed);
    return {
      serverSeedHash: hashServerSeed(q.serverSeed),
      number,
      color: colorOf(number),
    };
  }

  /** Hash of the server seed the next spin will use (commit before betting). */
  @Get('fairness')
  fairness(@CurrentUser('id') userId: string) {
    return this.roulette.getNextSeedHash(userId);
  }

  /** Bets, spins and settles in one go. The client animates to `round.number`. */
  @Post('spin')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  spin(
    @CurrentUser('id') userId: string,
    @Body({ schema: spinBody }) body: z.infer<typeof spinBody>,
  ) {
    return this.roulette.spin(userId, body.requestId, body.bets, body.clientSeed);
  }

  /** The 10 most recent spins. */
  @Get('history')
  async history(@CurrentUser('id') userId: string) {
    return { items: await this.roulette.history(userId, 10) };
  }

  @Get(':id')
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return { round: await this.roulette.getRound(userId, id) };
  }
}
