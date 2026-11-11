import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { hashServerSeed } from '../shared/fairness.js';
import {
  AUTO_CASHOUT_MAX_X100,
  AUTO_CASHOUT_MIN_X100,
  CRASH_BET_OPTIONS,
  crashPointX100,
} from './crash.math.js';
import { CrashService } from './crash.service.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/, 'invalid id');

const startBody = z.object({
  bet: z.union(CRASH_BET_OPTIONS.map((v) => z.literal(v))),
  /** Optional auto cash-out multiplier, e.g. 2 for 2.00×. */
  autoCashout: z
    .number()
    .min(AUTO_CASHOUT_MIN_X100 / 100)
    .max(AUTO_CASHOUT_MAX_X100 / 100)
    .optional(),
  clientSeed: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, '1-64 chars of A-Z a-z 0-9 _ -')
    .optional(),
});

const verifyQuery = z.object({
  serverSeed: z.string().regex(/^[0-9a-f]{64}$/),
  clientSeed: z.string().min(1).max(64),
});

@Controller('games/crash')
export class CrashController {
  constructor(private readonly crash: CrashService) {}

  /** Bet options, growth curve constant, limits. */
  @Public()
  @Get('config')
  config() {
    return this.crash.getConfig();
  }

  /** Recomputes a round's crash point from its revealed seeds. */
  @Public()
  @Get('verify')
  verify(@Query({ schema: verifyQuery }) q: z.infer<typeof verifyQuery>) {
    return {
      serverSeedHash: hashServerSeed(q.serverSeed),
      crashPoint: crashPointX100(q.serverSeed, q.clientSeed) / 100,
    };
  }

  /** Hash of the server seed the next round will use (commit before betting). */
  @Get('fairness')
  fairness(@CurrentUser('id') userId: string) {
    return this.crash.getNextSeedHash(userId);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  start(
    @CurrentUser('id') userId: string,
    @Body({ schema: startBody }) body: z.infer<typeof startBody>,
  ) {
    return this.crash.start(userId, body.bet, body.autoCashout, body.clientSeed);
  }

  /** The running round (`null` if none). Call on load to resume after a refresh. */
  @Get('active')
  async active(@CurrentUser('id') userId: string) {
    return { game: await this.crash.getActive(userId) };
  }

  /** The 10 most recent finished rounds. */
  @Get('history')
  async history(@CurrentUser('id') userId: string) {
    return { items: await this.crash.history(userId, 10) };
  }

  @Get(':id')
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return { game: await this.crash.getGame(userId, id) };
  }

  /** Long-poll: answers at the crash / auto cash-out, or after 20 s. */
  @Get(':id/wait')
  wait(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return this.crash.wait(userId, id);
  }

  @Post(':id/cashout')
  @HttpCode(200)
  cashOut(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return this.crash.cashOut(userId, id);
  }
}
