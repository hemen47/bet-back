import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { bombPositions, hashServerSeed } from './mines.fairness.js';
import { BET_OPTIONS, MINES_COUNT, MINES_TILES } from './mines.math.js';
import { MinesService } from './mines.service.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/, 'invalid id');

const startBody = z.object({
  bet: z.union(BET_OPTIONS.map((v) => z.literal(v))),
  clientSeed: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, '1-64 chars of A-Z a-z 0-9 _ -')
    .optional(),
});

const revealBody = z.object({
  tile: z
    .number()
    .int()
    .min(0)
    .max(MINES_TILES - 1),
});

const verifyQuery = z.object({
  serverSeed: z.string().regex(/^[0-9a-f]{64}$/),
  clientSeed: z.string().min(1).max(64),
});

@Controller('games/mines')
export class MinesController {
  constructor(private readonly mines: MinesService) {}

  /** Grid size, bet options and the multiplier for each step. */
  @Public()
  @Get('config')
  config() {
    return this.mines.getConfig();
  }

  /** Recomputes bomb positions from revealed seeds, so anyone can check a game. */
  @Public()
  @Get('verify')
  verify(@Query({ schema: verifyQuery }) q: z.infer<typeof verifyQuery>) {
    return {
      serverSeedHash: hashServerSeed(q.serverSeed),
      bombs: bombPositions(
        q.serverSeed,
        q.clientSeed,
        MINES_TILES,
        MINES_COUNT,
      ),
    };
  }

  /** Hash of the server seed the next game will use (commit before playing). */
  @Get('fairness')
  fairness(@CurrentUser('id') userId: string) {
    return this.mines.getNextSeedHash(userId);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  start(
    @CurrentUser('id') userId: string,
    @Body({ schema: startBody }) body: z.infer<typeof startBody>,
  ) {
    return this.mines.start(userId, body.bet, body.clientSeed);
  }

  /** The unfinished game (`null` if none). Call on load to resume after a refresh. */
  @Get('active')
  async active(@CurrentUser('id') userId: string) {
    return { game: await this.mines.getActive(userId) };
  }

  /** The 10 most recent finished games. */
  @Get('history')
  async history(@CurrentUser('id') userId: string) {
    return { items: await this.mines.history(userId, 10) };
  }

  @Get(':id')
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return { game: await this.mines.getGame(userId, id) };
  }

  @Post(':id/reveal')
  @HttpCode(200)
  reveal(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
    @Body({ schema: revealBody }) body: z.infer<typeof revealBody>,
  ) {
    return this.mines.reveal(userId, id, body.tile);
  }

  @Post(':id/cashout')
  @HttpCode(200)
  cashOut(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: objectId }) id: string,
  ) {
    return this.mines.cashOut(userId, id);
  }
}
