import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { Model, Types } from 'mongoose';
import { coinsToUnits, unitsToCoins } from '../../common/money.js';
import { isDuplicateKeyError } from '../../common/mongo.js';
import { WalletService } from '../../wallet/wallet.service.js';
import {
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
} from '../shared/fairness.js';
import {
  CrashGame,
  CrashGameDocument,
  CrashSeed,
  CrashStatus,
} from './crash-game.schema.js';
import {
  AUTO_CASHOUT_MAX_X100,
  AUTO_CASHOUT_MIN_X100,
  CRASH_BET_OPTIONS,
  CRASH_HOUSE_EDGE_PERCENT,
  crashPayoutUnits,
  crashPointX100,
  GROWTH_PER_MS,
  MAX_CRASH_X100,
  msToReach,
  multiplierAtX100,
  nextEventMs,
  outcomeAt,
  START_DELAY_MS,
} from './crash.math.js';

const GAME = 'crash';
const SECRETS = '+crashPointX100 +serverSeed';
/** A long-poll answers at the next event or after this long, whichever comes first. */
const LONG_POLL_MAX_MS = 20_000;

export interface CrashGameView {
  id: string;
  status: CrashStatus;
  bet: number;
  autoCashout: number | null;
  /** Lift-off time. The multiplier at time t is a pure function of t - startsAt. */
  startsAt: string;
  /** Server clock (ms since epoch) when this view was built, to sync the client's clock. */
  serverNow: number;
  /** Where the player cashed out (manual or auto); null otherwise. */
  cashoutMultiplier: number | null;
  payout: number;
  /** payout - bet once the round is over; null while running. */
  profit: number | null;
  /** Revealed once the round is over for this player. */
  crashPoint: number | null;
  fairness: {
    serverSeedHash: string;
    clientSeed: string;
    serverSeed: string | null;
  };
  createdAt: Date;
  endedAt: Date | null;
}

export interface CrashHistoryItem {
  id: string;
  bet: number;
  crashPoint: number;
  cashoutMultiplier: number | null;
  payout: number;
  profit: number;
  result: 'won' | 'lost';
  createdAt: Date;
  endedAt: Date;
}

const conflict = (error: string, message: string) =>
  new ConflictException({ statusCode: 409, error, message });

/** Thrown inside a transaction when another request settled the round first. */
class AlreadySettled extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class CrashService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CrashGame.name) private readonly games: Model<CrashGame>,
    @InjectModel(CrashSeed.name) private readonly seeds: Model<CrashSeed>,
    private readonly wallet: WalletService,
  ) {}

  getConfig() {
    return {
      betOptions: CRASH_BET_OPTIONS,
      houseEdge: CRASH_HOUSE_EDGE_PERCENT / 100,
      /** m(t) = floor(100 · e^(growthPerMs · t)) / 100, t in ms since lift-off. */
      growthPerMs: GROWTH_PER_MS,
      startDelayMs: START_DELAY_MS,
      maxMultiplier: MAX_CRASH_X100 / 100,
      autoCashout: {
        min: AUTO_CASHOUT_MIN_X100 / 100,
        max: AUTO_CASHOUT_MAX_X100 / 100,
      },
    };
  }

  /** The hash of the server seed the user's next round will use. */
  async getNextSeedHash(userId: string): Promise<{ serverSeedHash: string }> {
    const uid = new Types.ObjectId(userId);
    const existing = await this.seeds.findOne({ userId: uid }).lean();
    if (existing) return { serverSeedHash: existing.serverSeedHash };
    const serverSeed = generateServerSeed();
    try {
      const created = await this.seeds.create({
        userId: uid,
        serverSeed,
        serverSeedHash: hashServerSeed(serverSeed),
      });
      return { serverSeedHash: created.serverSeedHash };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.seeds.findOne({ userId: uid }).lean().orFail();
      return { serverSeedHash: raced.serverSeedHash };
    }
  }

  /**
   * Places the bet and fixes the crash point, in one transaction. The
   * partial unique index allows one running round per user.
   */
  async start(
    userId: string,
    bet: number,
    autoCashout?: number,
    clientSeed?: string,
  ): Promise<{ game: CrashGameView; balance: number }> {
    if (!(CRASH_BET_OPTIONS as readonly number[]).includes(bet)) {
      throw new BadRequestException(
        `bet must be one of ${CRASH_BET_OPTIONS.join(', ')}`,
      );
    }
    let autoX100: number | undefined;
    if (autoCashout !== undefined) {
      autoX100 = Math.round(autoCashout * 100);
      if (autoX100 < AUTO_CASHOUT_MIN_X100 || autoX100 > AUTO_CASHOUT_MAX_X100) {
        throw new BadRequestException(
          `autoCashout must be ${AUTO_CASHOUT_MIN_X100 / 100}..${AUTO_CASHOUT_MAX_X100 / 100}`,
        );
      }
    }

    const uid = new Types.ObjectId(userId);
    const betUnits = coinsToUnits(bet);
    const seed = clientSeed ?? generateClientSeed();

    try {
      return await this.connection.transaction(async (session) => {
        const serverSeed = await this.consumeServerSeed(uid, session);
        const gameId = new Types.ObjectId();
        const [game] = await this.games.create(
          [
            {
              _id: gameId,
              userId: uid,
              status: 'running',
              betAmount: betUnits,
              autoCashoutX100: autoX100,
              crashPointX100: crashPointX100(serverSeed, seed),
              serverSeed,
              serverSeedHash: hashServerSeed(serverSeed),
              clientSeed: seed,
              startsAt: new Date(Date.now() + START_DELAY_MS),
            },
          ],
          { session },
        );
        const balance = await this.wallet.debit(
          uid,
          betUnits,
          { type: 'bet', key: `${GAME}:${gameId.toString()}:bet`, game: GAME, gameId },
          session,
        );
        return { game: this.toView(game), balance: unitsToCoins(balance) };
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw conflict('active_game_exists', 'Finish your current round first');
      }
      throw error;
    }
  }

  /** The running round, if any (settled first if its time has passed). */
  async getActive(userId: string): Promise<CrashGameView | null> {
    const found = await this.games
      .findOne({ userId: new Types.ObjectId(userId), status: 'running' })
      .select(SECRETS);
    if (!found) return null;
    const game = await this.resolve(found);
    return game.status === 'running' ? this.toView(game) : null;
  }

  async getGame(userId: string, gameId: string): Promise<CrashGameView> {
    return this.toView(await this.resolve(await this.findOwned(userId, gameId)));
  }

  /**
   * Long-poll: answers when the round crashes or auto-cashes out (at that
   * exact moment), or after 20 s if nothing happened yet. This is how the
   * client learns about the crash without ever seeing the crash point early.
   */
  async wait(
    userId: string,
    gameId: string,
  ): Promise<{ game: CrashGameView; balance: number | null }> {
    let game = await this.findOwned(userId, gameId);
    if (game.status === 'running') {
      const elapsed = Date.now() - game.startsAt.getTime();
      const remaining =
        nextEventMs(game.crashPointX100, game.autoCashoutX100) - elapsed;
      if (remaining > 0) await sleep(Math.min(remaining, LONG_POLL_MAX_MS));
      // Re-read: the player may have cashed out while we waited.
      game = await this.resolve(await this.findOwned(userId, gameId));
    }
    return {
      game: this.toView(game),
      balance:
        game.status === 'running' ? null : await this.wallet.getBalance(userId),
    };
  }

  /**
   * Cashes out at the multiplier of the moment the request reaches the
   * server. The client's idea of the multiplier is never trusted.
   */
  async cashOut(
    userId: string,
    gameId: string,
  ): Promise<{ game: CrashGameView; balance: number | null }> {
    const game = await this.findOwned(userId, gameId);
    if (game.status !== 'running') {
      throw conflict('game_over', 'This round is already over');
    }
    const elapsed = Date.now() - game.startsAt.getTime();
    if (elapsed < 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'not_started',
        message: 'The round has not started yet',
      });
    }

    const outcome = outcomeAt(elapsed, game.crashPointX100, game.autoCashoutX100);
    if (outcome.kind === 'crashed') {
      // Too late: the round crashed before this request arrived.
      return { game: this.toView(await this.settleCrash(game)), balance: null };
    }
    const x100 =
      outcome.kind === 'auto_cashout' ? outcome.x100 : multiplierAtX100(elapsed);
    const { doc, balance } = await this.settleWin(game, x100, new Date());
    return {
      game: this.toView(doc),
      balance: balance === null ? null : unitsToCoins(balance),
    };
  }

  async history(userId: string, limit = 10): Promise<CrashHistoryItem[]> {
    await this.getActive(userId); // settles a round that ended while nobody was looking
    const games = await this.games
      .find({ userId: new Types.ObjectId(userId), status: { $ne: 'running' } })
      .select('+crashPointX100')
      .sort({ endedAt: -1 })
      .limit(limit)
      .lean();
    return games.map((g) => ({
      id: g._id.toString(),
      bet: unitsToCoins(g.betAmount),
      crashPoint: g.crashPointX100 / 100,
      cashoutMultiplier: g.cashoutX100 ? g.cashoutX100 / 100 : null,
      payout: unitsToCoins(g.payout),
      profit: unitsToCoins(g.payout - g.betAmount),
      result: g.status === 'cashed_out' ? 'won' : 'lost',
      createdAt: g.createdAt,
      endedAt: g.endedAt!,
    }));
  }

  // ---- Settlement ------------------------------------------------------

  /** Settles a running round whose crash or auto cash-out time has passed. */
  private async resolve(game: CrashGameDocument): Promise<CrashGameDocument> {
    if (game.status !== 'running') return game;
    const elapsed = Date.now() - game.startsAt.getTime();
    const outcome = outcomeAt(elapsed, game.crashPointX100, game.autoCashoutX100);
    if (outcome.kind === 'running') return game;
    if (outcome.kind === 'crashed') return this.settleCrash(game);
    const at = new Date(game.startsAt.getTime() + msToReach(outcome.x100));
    return (await this.settleWin(game, outcome.x100, at)).doc;
  }

  private async settleCrash(game: CrashGameDocument): Promise<CrashGameDocument> {
    const crashedAt = new Date(
      game.startsAt.getTime() + msToReach(game.crashPointX100),
    );
    const updated = await this.games.findOneAndUpdate(
      { _id: game._id, status: 'running' },
      { $set: { status: 'crashed', payout: 0, endedAt: crashedAt } },
      { returnDocument: 'after', projection: SECRETS },
    );
    // Null: another request settled it first; return what it decided.
    return updated ?? this.reload(game._id);
  }

  /**
   * Ends the round as cashed out and credits the payout, in one transaction.
   * The status change is conditional on `running` and the ledger key is
   * unique per round, so concurrent cash-outs pay exactly once.
   */
  private async settleWin(
    game: CrashGameDocument,
    x100: number,
    endedAt: Date,
  ): Promise<{ doc: CrashGameDocument; balance: number | null }> {
    const payout = crashPayoutUnits(game.betAmount, x100);
    try {
      return await this.connection.transaction(async (session) => {
        const won = await this.games.findOneAndUpdate(
          { _id: game._id, status: 'running' },
          { $set: { status: 'cashed_out', cashoutX100: x100, payout, endedAt } },
          { returnDocument: 'after', session, projection: SECRETS },
        );
        if (!won) throw new AlreadySettled();
        const balance = await this.wallet.credit(
          game.userId,
          payout,
          {
            type: 'win',
            key: `${GAME}:${game._id.toString()}:payout`,
            game: GAME,
            gameId: game._id,
          },
          session,
        );
        return { doc: won, balance };
      });
    } catch (error) {
      if (error instanceof AlreadySettled || isDuplicateKeyError(error)) {
        return { doc: await this.reload(game._id), balance: null };
      }
      throw error;
    }
  }

  // ---- Helpers ---------------------------------------------------------

  /** Swaps the committed seed for a fresh one, returning the committed one. */
  private async consumeServerSeed(
    userId: Types.ObjectId,
    session: ClientSession,
  ): Promise<string> {
    const next = generateServerSeed();
    const previous = await this.seeds
      .findOneAndUpdate(
        { userId },
        { $set: { serverSeed: next, serverSeedHash: hashServerSeed(next) } },
        { upsert: true, returnDocument: 'before', session },
      )
      .select('+serverSeed');
    return previous?.serverSeed ?? generateServerSeed();
  }

  private async findOwned(userId: string, gameId: string): Promise<CrashGameDocument> {
    if (!Types.ObjectId.isValid(gameId)) throw new NotFoundException('Round not found');
    const game = await this.games
      .findOne({
        _id: new Types.ObjectId(gameId),
        userId: new Types.ObjectId(userId),
      })
      .select(SECRETS);
    if (!game) throw new NotFoundException('Round not found');
    return game;
  }

  private async reload(id: Types.ObjectId): Promise<CrashGameDocument> {
    return this.games.findById(id).select(SECRETS).orFail();
  }

  /** The only shape that leaves the server. Secrets only once the round is over. */
  private toView(game: CrashGameDocument): CrashGameView {
    const over = game.status !== 'running';
    return {
      id: game.id as string,
      status: game.status,
      bet: unitsToCoins(game.betAmount),
      autoCashout: game.autoCashoutX100 ? game.autoCashoutX100 / 100 : null,
      startsAt: game.startsAt.toISOString(),
      serverNow: Date.now(),
      cashoutMultiplier: game.cashoutX100 ? game.cashoutX100 / 100 : null,
      payout: unitsToCoins(game.payout),
      profit: over ? unitsToCoins(game.payout - game.betAmount) : null,
      crashPoint: over ? game.crashPointX100 / 100 : null,
      fairness: {
        serverSeedHash: game.serverSeedHash,
        clientSeed: game.clientSeed,
        serverSeed: over ? (game.serverSeed ?? null) : null,
      },
      createdAt: game.createdAt,
      endedAt: game.endedAt ?? null,
    };
  }
}
