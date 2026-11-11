import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { hashServerSeed } from '../shared/fairness.js';
import { POOP_BET_OPTIONS, POOP_CHOICES, POOP_STAGES, roundAnswers } from './poop.math.js';
import { PoopService } from './poop.service.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/, 'invalid id');

const startBody = z.object({
  bet: z.union(POOP_BET_OPTIONS.map((v) => z.literal(v))),
  clientSeed: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, '1-64 chars of A-Z a-z 0-9 _ -')
    .optional(),
});

const pickBody = z.object({
  /** The stage being answered (1-based). Makes a repeated request harmless. */
  stage: z.number().int().min(1).max(POOP_STAGES),
  choice: z.enum(POOP_CHOICES),
});

const verifyQuery = z.object({
  serverSeed: z.string().regex(/^[0-9a-f]{64}$/),
  clientSeed: z.string().min(1).max(64),
});

@Controller('games/poop')
export class PoopController {
  constructor(private readonly poop: PoopService) {}

  /** Stages, bet options and the multiplier table. */
  @Public()
  @Get('config')
  config() {
    return this.poop.getConfig();
  }

  /** Recomputes a round's 5 answers from its revealed seeds. */
  @Public()
  @Get('verify')
  verify(@Query({ schema: verifyQuery }) q: z.infer<typeof verifyQuery>) {
    return {
      serverSeedHash: hashServerSeed(q.serverSeed),
      answers: roundAnswers(q.serverSeed, q.clientSeed),
    };
  }

  /** Hash of the server seed the next round will use (commit before playing). */
  @Get('fairness')
  fairness(@CurrentUser('id') userId: string) {
    return this.poop.getNextSeedHash(userId);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  start(
    @CurrentUser('id') userId: string,
    @Body({ schema: startBody }) body: z.infer<typeof startBody>,
  ) {
    return this.poop.start(userId, body.bet, body.clientSeed);
  }

  /** The unfinished round (`null` if none). Call on load to resume after a refresh. */
  @Get('active')
  async active(@CurrentUser('id') userId: string) {
    return { game: await this.poop.getActive(userId) };
  }

  /** The 10 most recent finished rounds. */
  @Get('history')
  async history(@CurrentUser('id') userId: string) {
    return { items: await this.poop.history(userId, 10) };
  }

  @Get(':id')
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return { game: await this.poop.getGame(userId, id) };
  }

  @Post(':id/pick')
  @HttpCode(200)
  pick(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
    @Body({ schema: pickBody }) body: z.infer<typeof pickBody>,
  ) {
    return this.poop.pick(userId, id, body.stage, body.choice);
  }

  @Post(':id/cashout')
  @HttpCode(200)
  cashOut(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return this.poop.cashOut(userId, id);
  }
}
