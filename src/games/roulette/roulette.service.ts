import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  RouletteRound,
  RouletteRoundDocument,
  RouletteSeed,
} from './roulette-round.schema.js';
import {
  BET_TARGET_PATTERN,
  betPayoutUnits,
  colorOf,
  MAX_BETS,
  MAX_TOTAL_BET,
  payoutMultiplier,
  payoutTable,
  PocketColor,
  RED_NUMBERS,
  ROULETTE_CHIPS,
  spinNumber,
  WHEEL_ORDER,
} from './roulette.math.js';

const GAME = 'roulette';
/** Every chip is a multiple of this, so every stake is too. */
const STAKE_STEP = 10;

export interface RouletteBetInput {
  target: string;
  amount: number;
}

export interface RouletteRoundView {
  id: string;
  number: number;
  color: PocketColor;
  bets: {
    target: string;
    amount: number;
    multiplier: number;
    payout: number;
    won: boolean;
  }[];
  totalBet: number;
  payout: number;
  profit: number;
  fairness: { serverSeedHash: string; clientSeed: string; serverSeed: string };
  createdAt: Date;
}

export interface SpinResult {
  round: RouletteRoundView;
  /** Balance right after the stake was taken: show it while the wheel spins. */
  balanceAfterBet: number;
  /** Final balance, once the payout (if any) is credited. */
  balance: number;
  /** True when this requestId had already been spun: nothing was charged again. */
  replayed: boolean;
}

@Injectable()
export class RouletteService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(RouletteRound.name) private readonly rounds: Model<RouletteRound>,
    @InjectModel(RouletteSeed.name) private readonly seeds: Model<RouletteSeed>,
    private readonly wallet: WalletService,
  ) {}

  getConfig() {
    return {
      chips: ROULETTE_CHIPS,
      maxTotalBet: MAX_TOTAL_BET,
      maxBets: MAX_BETS,
      houseEdge: 1 / 37,
      wheelOrder: WHEEL_ORDER,
      redNumbers: RED_NUMBERS,
      payouts: payoutTable(),
    };
  }

  /** The hash of the server seed the user's next spin will use. */
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
   * Places every bet, draws the number and pays out, in one transaction.
   * The stake is debited atomically (never below zero), and the unique
   * (userId, requestId) index turns a duplicate submission into a replay of
   * the first result instead of a second charge.
   */
  async spin(
    userId: string,
    requestId: string,
    input: RouletteBetInput[],
    clientSeed?: string,
  ): Promise<SpinResult> {
    const bets = this.normalizeBets(input);
    const uid = new Types.ObjectId(userId);

    const previous = await this.rounds.findOne({ userId: uid, requestId });
    if (previous) return this.replay(userId, previous);

    const seed = clientSeed ?? generateClientSeed();
    const totalBet = bets.reduce((sum, b) => sum + b.amount, 0);

    try {
      return await this.connection.transaction(async (session) => {
        const serverSeed = await this.consumeServerSeed(uid, session);
        const number = spinNumber(serverSeed, seed);
        const settled = bets.map((b) => ({
          ...b,
          payout: betPayoutUnits(b.target, b.amount, number),
        }));
        const payout = settled.reduce((sum, b) => sum + b.payout, 0);
        const roundId = new Types.ObjectId();

        const [round] = await this.rounds.create(
          [
            {
              _id: roundId,
              userId: uid,
              requestId,
              bets: settled,
              totalBet,
              number,
              color: colorOf(number),
              payout,
              serverSeed,
              serverSeedHash: hashServerSeed(serverSeed),
              clientSeed: seed,
            },
          ],
          { session },
        );
        const ref = { game: GAME, gameId: roundId };
        const afterBet = await this.wallet.debit(
          uid,
          totalBet,
          { type: 'bet', key: `${GAME}:${roundId.toString()}:bet`, ...ref },
          session,
        );
        const balance =
          payout > 0
            ? await this.wallet.credit(
                uid,
                payout,
                { type: 'win', key: `${GAME}:${roundId.toString()}:payout`, ...ref },
                session,
              )
            : afterBet;

        return {
          round: this.toView(round),
          balanceAfterBet: unitsToCoins(afterBet),
          balance: unitsToCoins(balance),
          replayed: false,
        };
      });
    } catch (error) {
      // Two identical requests raced: the other one committed first.
      if (isDuplicateKeyError(error)) {
        const winner = await this.rounds.findOne({ userId: uid, requestId });
        if (winner) return this.replay(userId, winner);
      }
      throw error;
    }
  }

  async history(userId: string, limit = 10): Promise<RouletteRoundView[]> {
    const rounds = await this.rounds
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(limit);
    return rounds.map((r) => this.toView(r));
  }

  async getRound(userId: string, roundId: string): Promise<RouletteRoundView> {
    if (!Types.ObjectId.isValid(roundId)) throw new NotFoundException('Round not found');
    const round = await this.rounds.findOne({
      _id: new Types.ObjectId(roundId),
      userId: new Types.ObjectId(userId),
    });
    if (!round) throw new NotFoundException('Round not found');
    return this.toView(round);
  }

  // ---- Helpers ---------------------------------------------------------

  /**
   * Validates targets and amounts, merges chips on the same target, and
   * converts to units. The client's totals are never trusted.
   */
  private normalizeBets(input: RouletteBetInput[]): { target: string; amount: number }[] {
    const bad = (message: string) =>
      new BadRequestException({ statusCode: 400, error: 'invalid_bet', message });
    if (input.length === 0) throw bad('Place at least one bet');

    const merged = new Map<string, number>();
    for (const { target, amount } of input) {
      if (!BET_TARGET_PATTERN.test(target)) throw bad(`Unknown bet: ${target}`);
      if (!Number.isInteger(amount) || amount <= 0 || amount % STAKE_STEP !== 0) {
        throw bad(`Bet amounts must be multiples of ${STAKE_STEP}`);
      }
      merged.set(target, (merged.get(target) ?? 0) + amount);
    }
    if (merged.size > MAX_BETS) throw bad(`At most ${MAX_BETS} bets per spin`);
    const total = [...merged.values()].reduce((a, b) => a + b, 0);
    if (total > MAX_TOTAL_BET) throw bad(`At most ${MAX_TOTAL_BET} coins per spin`);

    return [...merged].map(([target, amount]) => ({
      target,
      amount: coinsToUnits(amount),
    }));
  }

  private async replay(userId: string, round: RouletteRoundDocument): Promise<SpinResult> {
    const balance = await this.wallet.getBalance(userId);
    return {
      round: this.toView(round),
      balanceAfterBet: balance - unitsToCoins(round.payout),
      balance,
      replayed: true,
    };
  }

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

  /** The only shape that leaves the server. */
  private toView(round: RouletteRoundDocument): RouletteRoundView {
    return {
      id: round.id as string,
      number: round.number,
      color: round.color,
      bets: round.bets.map((b) => ({
        target: b.target,
        amount: unitsToCoins(b.amount),
        multiplier: payoutMultiplier(b.target),
        payout: unitsToCoins(b.payout),
        won: b.payout > 0,
      })),
      totalBet: unitsToCoins(round.totalBet),
      payout: unitsToCoins(round.payout),
      profit: unitsToCoins(round.payout - round.totalBet),
      fairness: {
        serverSeedHash: round.serverSeedHash,
        clientSeed: round.clientSeed,
        serverSeed: round.serverSeed,
      },
      createdAt: round.createdAt,
    };
  }
}
