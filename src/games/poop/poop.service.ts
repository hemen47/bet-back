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
import { MissionsService } from '../../missions/missions.service.js';
import { WalletService } from '../../wallet/wallet.service.js';
import {
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
} from '../shared/fairness.js';
import { PoopGame, PoopGameDocument, PoopSeed, PoopStatus } from './poop-game.schema.js';
import {
  POOP_BET_OPTIONS,
  POOP_HOUSE_EDGE_PERCENT,
  POOP_STAGES,
  type PoopChoice,
  poopMultiplierX100,
  poopPayoutUnits,
  poopTable,
  roundAnswers,
} from './poop.math.js';

const GAME = 'poop';
const SECRETS = '+answers +serverSeed';

export interface PoopGameView {
  id: string;
  status: PoopStatus;
  bet: number;
  stages: number;
  /** Stages completed (correct picks). */
  completed: number;
  picks: { choice: PoopChoice; correct: boolean }[];
  multiplier: number;
  /** Multiplier the next correct pick gives; null when over or at the top. */
  nextMultiplier: number | null;
  /** What cashing out pays right now (0 before the first correct pick). */
  cashoutAmount: number;
  canCashOut: boolean;
  payout: number;
  profit: number | null;
  /** All 5 correct answers, revealed once the round is over. */
  answers: PoopChoice[] | null;
  fairness: { serverSeedHash: string; clientSeed: string; serverSeed: string | null };
  createdAt: Date;
  endedAt: Date | null;
}

export interface PoopHistoryItem {
  id: string;
  bet: number;
  completed: number;
  /** Cash-out multiplier when won; null when lost. */
  multiplier: number | null;
  payout: number;
  profit: number;
  result: 'won' | 'lost';
  createdAt: Date;
  endedAt: Date;
}

const conflict = (error: string, message: string) =>
  new ConflictException({ statusCode: 409, error, message });

@Injectable()
export class PoopService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(PoopGame.name) private readonly games: Model<PoopGame>,
    @InjectModel(PoopSeed.name) private readonly seeds: Model<PoopSeed>,
    private readonly wallet: WalletService,
    private readonly missions: MissionsService,
  ) {}

  getConfig() {
    return {
      stages: POOP_STAGES,
      choices: ['poop', 'laugh'],
      betOptions: POOP_BET_OPTIONS,
      houseEdge: POOP_HOUSE_EDGE_PERCENT / 100,
      multipliers: poopTable(),
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
   * Takes the bet and fixes all 5 answers, in one transaction. The partial
   * unique index allows one active round per user.
   */
  async start(
    userId: string,
    bet: number,
    clientSeed?: string,
  ): Promise<{ game: PoopGameView; balance: number }> {
    if (!(POOP_BET_OPTIONS as readonly number[]).includes(bet)) {
      throw new BadRequestException(`bet must be one of ${POOP_BET_OPTIONS.join(', ')}`);
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
              status: 'active',
              betAmount: betUnits,
              answers: roundAnswers(serverSeed, seed),
              serverSeed,
              serverSeedHash: hashServerSeed(serverSeed),
              clientSeed: seed,
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

  async getActive(userId: string): Promise<PoopGameView | null> {
    const game = await this.games.findOne({ userId: new Types.ObjectId(userId), status: 'active' });
    return game ? this.toView(game) : null;
  }

  async getGame(userId: string, gameId: string): Promise<PoopGameView> {
    return this.toView(await this.findOwned(userId, gameId, false));
  }

  /**
   * Answers stage `stage` (1-based) with `choice`. `stage` must be the next
   * one: a repeat of an already answered stage with the same choice (double
   * tap, retry after a lost response) just returns the current state, and
   * anything else is refused, so a request can never apply twice.
   */
  async pick(
    userId: string,
    gameId: string,
    stage: number,
    choice: PoopChoice,
  ): Promise<{ game: PoopGameView; balance: number | null; replayed: boolean }> {
    const game = await this.findOwned(userId, gameId, true);

    const previous = game.picks[stage - 1];
    if (previous) {
      if (previous.choice === choice) {
        return { game: this.toView(game), balance: null, replayed: true };
      }
      throw conflict('stale_move', 'That stage was already played');
    }
    this.assertActive(game);
    if (stage !== game.step + 1) {
      throw conflict('stale_move', `Expected stage ${game.step + 1}`);
    }

    const correct = game.answers[stage - 1] === choice;
    if (!correct) {
      const lost = await this.games.findOneAndUpdate(
        { _id: game._id, status: 'active', step: game.step },
        {
          $push: { picks: { choice, correct: false } },
          $set: { status: 'lost', multiplierX100: 0, payout: 0, endedAt: new Date() },
        },
        { returnDocument: 'after', projection: SECRETS },
      );
      if (!lost) return this.replayOrStale(userId, gameId, stage, choice);
      void this.missions.increment(game.userId, 'poop_play_5');
      return { game: this.toView(lost), balance: null, replayed: false };
    }

    const step = game.step + 1;
    const mult = poopMultiplierX100(step);

    // All 5 cleared: nothing left to risk, the prize is paid automatically.
    if (step === POOP_STAGES) {
      let won;
      try {
        won = await this.settleWin(game, { choice, multX100: mult });
      } catch (error) {
        if (error instanceof ConflictException) return this.replayOrStale(userId, gameId, stage, choice);
        throw error;
      }
      this.reportStreak(game.userId, step);
      return { ...won, replayed: false };
    }

    const updated = await this.games.findOneAndUpdate(
      { _id: game._id, status: 'active', step: game.step },
      { $push: { picks: { choice, correct: true } }, $set: { step, multiplierX100: mult } },
      { returnDocument: 'after' },
    );
    if (!updated) return this.replayOrStale(userId, gameId, stage, choice);
    this.reportStreak(game.userId, step);
    return { game: this.toView(updated), balance: null, replayed: false };
  }

  /**
   * A conditional update lost a race. If the winner was the same pick (two
   * copies of one request), answer with the result; otherwise it's stale.
   */
  private async replayOrStale(userId: string, gameId: string, stage: number, choice: PoopChoice) {
    const fresh = await this.findOwned(userId, gameId, true);
    if (fresh.picks[stage - 1]?.choice === choice) {
      return { game: this.toView(fresh), balance: null, replayed: true };
    }
    throw this.staleMove();
  }

  /** Mission progress for `step` correct picks in a row (best effort). */
  private reportStreak(userId: Types.ObjectId, step: number): void {
    void this.missions.raiseTo(userId, 'poop_streak_2', step);
    void this.missions.raiseTo(userId, 'poop_reach_760', step);
  }

  /** Pays bet × current multiplier. Allowed after at least one correct pick. */
  async cashOut(userId: string, gameId: string): Promise<{ game: PoopGameView; balance: number }> {
    const game = await this.findOwned(userId, gameId, false);
    this.assertActive(game);
    if (game.step < 1) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'nothing_to_cash_out',
        message: 'Make a correct pick first',
      });
    }
    return this.settleWin(game, { multX100: game.multiplierX100 });
  }

  async history(userId: string, limit = 10): Promise<PoopHistoryItem[]> {
    const games = await this.games
      .find({ userId: new Types.ObjectId(userId), status: { $ne: 'active' } })
      .sort({ endedAt: -1 })
      .limit(limit)
      .lean();
    return games.map((g) => ({
      id: g._id.toString(),
      bet: unitsToCoins(g.betAmount),
      completed: g.step,
      multiplier: g.status === 'won' ? g.multiplierX100 / 100 : null,
      payout: unitsToCoins(g.payout),
      profit: unitsToCoins(g.payout - g.betAmount),
      result: g.status as 'won' | 'lost',
      createdAt: g.createdAt,
      endedAt: g.endedAt!,
    }));
  }

  /**
   * Ends the round as won and credits the payout, in one transaction. The
   * update is conditional on the step we read and the ledger key is unique
   * per round, so a prize can never be paid twice.
   */
  private async settleWin(
    game: PoopGameDocument,
    { choice, multX100 }: { choice?: PoopChoice; multX100: number },
  ): Promise<{ game: PoopGameView; balance: number }> {
    const payout = poopPayoutUnits(game.betAmount, multX100);
    const result = await this.connection.transaction(async (session) => {
      const won = await this.games.findOneAndUpdate(
        { _id: game._id, status: 'active', step: game.step },
        {
          ...(choice && { $push: { picks: { choice, correct: true } } }),
          $set: {
            status: 'won',
            step: game.step + (choice ? 1 : 0),
            multiplierX100: multX100,
            payout,
            endedAt: new Date(),
          },
        },
        { returnDocument: 'after', session, projection: SECRETS },
      );
      if (!won) throw this.staleMove();
      const balance = await this.wallet.credit(
        game.userId,
        payout,
        { type: 'win', key: `${GAME}:${game._id.toString()}:payout`, game: GAME, gameId: game._id },
        session,
      );
      return { game: this.toView(won), balance: unitsToCoins(balance) };
    });
    void this.missions.increment(game.userId, 'poop_play_5');
    return result;
  }

  private async consumeServerSeed(userId: Types.ObjectId, session: ClientSession): Promise<string> {
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

  private async findOwned(userId: string, gameId: string, withSecrets: boolean): Promise<PoopGameDocument> {
    if (!Types.ObjectId.isValid(gameId)) throw new NotFoundException('Game not found');
    const query = this.games.findOne({
      _id: new Types.ObjectId(gameId),
      userId: new Types.ObjectId(userId),
    });
    if (withSecrets) query.select(SECRETS);
    const game = await query;
    if (!game) throw new NotFoundException('Game not found');
    return game;
  }

  private assertActive(game: PoopGameDocument): void {
    if (game.status !== 'active') throw conflict('game_over', 'This round is already over');
  }

  private staleMove() {
    return conflict('stale_move', 'The round changed; reload it and try again');
  }

  /** The only shape that leaves the server. Answers and seed only once the round is over. */
  private toView(game: PoopGameDocument): PoopGameView {
    const over = game.status !== 'active';
    return {
      id: game.id as string,
      status: game.status,
      bet: unitsToCoins(game.betAmount),
      stages: POOP_STAGES,
      completed: game.step,
      picks: game.picks.map((p) => ({ choice: p.choice, correct: p.correct })),
      multiplier: game.multiplierX100 / 100,
      nextMultiplier: !over && game.step < POOP_STAGES ? poopMultiplierX100(game.step + 1) / 100 : null,
      cashoutAmount: over || game.step === 0 ? 0 : unitsToCoins(poopPayoutUnits(game.betAmount, game.multiplierX100)),
      canCashOut: !over && game.step > 0,
      payout: unitsToCoins(game.payout),
      profit: over ? unitsToCoins(game.payout - game.betAmount) : null,
      answers: over && game.answers ? [...game.answers] : null,
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
