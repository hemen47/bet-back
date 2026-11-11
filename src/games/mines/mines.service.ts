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
  MinesGame,
  MinesGameDocument,
  MinesStatus,
} from './mines-game.schema.js';
import { MinesSeed } from './mines-seed.schema.js';
import {
  bombPositions,
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
} from './mines.fairness.js';
import {
  BET_OPTIONS,
  HOUSE_EDGE_PERCENT,
  MINES_COUNT,
  MINES_TILES,
  multiplierTable,
  multiplierX100,
  payoutUnits,
} from './mines.math.js';

const GAME = 'mines';

export interface MinesGameView {
  id: string;
  status: MinesStatus;
  bet: number;
  tiles: number;
  mines: number;
  revealed: number[];
  multiplier: number;
  /** Multiplier the next safe tile would give; null when none is left or the game is over. */
  nextMultiplier: number | null;
  /** What cashing out now pays (0 before the first safe tile). */
  cashoutAmount: number;
  payout: number;
  hitTile: number | null;
  canCashOut: boolean;
  fairness: {
    serverSeedHash: string;
    clientSeed: string;
    /** Revealed once the game is over. */
    serverSeed: string | null;
  };
  /** Revealed once the game is over. */
  bombs: number[] | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface MinesHistoryItem {
  id: string;
  bet: number;
  multiplier: number;
  payout: number;
  profit: number;
  result: 'won' | 'lost';
  createdAt: Date;
  endedAt: Date;
}

const conflict = (error: string, message: string) =>
  new ConflictException({ statusCode: 409, error, message });

@Injectable()
export class MinesService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MinesGame.name) private readonly games: Model<MinesGame>,
    @InjectModel(MinesSeed.name) private readonly seeds: Model<MinesSeed>,
    private readonly wallet: WalletService,
  ) {}

  getConfig() {
    return {
      tiles: MINES_TILES,
      rows: 3,
      columns: 3,
      mines: MINES_COUNT,
      betOptions: BET_OPTIONS,
      houseEdge: HOUSE_EDGE_PERCENT / 100,
      multipliers: multiplierTable(),
    };
  }

  /** The hash of the server seed the user's next game will use. */
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
   * Starts a game: takes the bet and fixes the bombs, in one transaction.
   * The partial unique index allows one active game per user, so a double
   * tap or a second tab can't start two games or spend twice.
   */
  async start(
    userId: string,
    bet: number,
    clientSeed?: string,
  ): Promise<{ game: MinesGameView; balance: number }> {
    if (!(BET_OPTIONS as readonly number[]).includes(bet)) {
      throw new BadRequestException(
        `bet must be one of ${BET_OPTIONS.join(', ')}`,
      );
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
              tiles: MINES_TILES,
              minesCount: MINES_COUNT,
              bombs: bombPositions(serverSeed, seed, MINES_TILES, MINES_COUNT),
              serverSeed,
              serverSeedHash: hashServerSeed(serverSeed),
              clientSeed: seed,
              revealed: [],
              step: 0,
              multiplierX100: 100,
            },
          ],
          { session },
        );
        const balance = await this.wallet.debit(
          uid,
          betUnits,
          {
            type: 'bet',
            key: `${GAME}:${gameId.toString()}:bet`,
            game: GAME,
            gameId,
          },
          session,
        );
        return { game: this.toView(game), balance: unitsToCoins(balance) };
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw conflict('active_game_exists', 'Finish your current game first');
      }
      throw error;
    }
  }

  /** The unfinished game, if any: what the Mini App restores after a refresh or reconnect. */
  async getActive(userId: string): Promise<MinesGameView | null> {
    const game = await this.games.findOne({
      userId: new Types.ObjectId(userId),
      status: 'active',
    });
    return game ? this.toView(game) : null;
  }

  async getGame(userId: string, gameId: string): Promise<MinesGameView> {
    const game = await this.findOwned(userId, gameId, true);
    return this.toView(game);
  }

  /** Uncovers a tile. Bomb positions are only ever read here, server-side. */
  async reveal(
    userId: string,
    gameId: string,
    tile: number,
  ): Promise<{ game: MinesGameView; balance: number | null }> {
    if (!Number.isInteger(tile) || tile < 0 || tile >= MINES_TILES) {
      throw new BadRequestException(`tile must be 0..${MINES_TILES - 1}`);
    }
    const game = await this.findOwned(userId, gameId, true);
    this.assertActive(game);
    if (game.revealed.includes(tile)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'tile_already_revealed',
        message: 'Tile already revealed',
      });
    }

    if (game.bombs.includes(tile)) {
      const lost = await this.games.findOneAndUpdate(
        { _id: game._id, status: 'active', step: game.step },
        {
          $set: {
            status: 'lost',
            hitTile: tile,
            multiplierX100: 0,
            payout: 0,
            endedAt: new Date(),
          },
        },
        { returnDocument: 'after', projection: '+bombs +serverSeed' },
      );
      if (!lost) throw this.staleMove();
      return { game: this.toView(lost), balance: null };
    }

    const step = game.step + 1;
    const mult = multiplierX100(step, game.tiles, game.minesCount);

    // Last safe tile: nothing left to risk, cash out automatically.
    if (step === game.tiles - game.minesCount) {
      return this.settleWin(game, { revealTile: tile, multX100: mult });
    }

    const updated = await this.games.findOneAndUpdate(
      { _id: game._id, status: 'active', step: game.step },
      { $push: { revealed: tile }, $set: { step, multiplierX100: mult } },
      { returnDocument: 'after' },
    );
    if (!updated) throw this.staleMove();
    return { game: this.toView(updated), balance: null };
  }

  /** Pays out the current multiplier. Allowed after at least one safe tile. */
  async cashOut(
    userId: string,
    gameId: string,
  ): Promise<{ game: MinesGameView; balance: number }> {
    const game = await this.findOwned(userId, gameId, false);
    this.assertActive(game);
    if (game.step < 1) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'nothing_to_cash_out',
        message: 'Reveal at least one tile first',
      });
    }
    return this.settleWin(game, { multX100: game.multiplierX100 });
  }

  async history(userId: string, limit = 10): Promise<MinesHistoryItem[]> {
    const games = await this.games
      .find({ userId: new Types.ObjectId(userId), status: { $ne: 'active' } })
      .sort({ endedAt: -1 })
      .limit(limit)
      .lean();
    return games.map((g) => ({
      id: g._id.toString(),
      bet: unitsToCoins(g.betAmount),
      multiplier: g.multiplierX100 / 100,
      payout: unitsToCoins(g.payout),
      profit: unitsToCoins(g.payout - g.betAmount),
      result: g.status as 'won' | 'lost',
      createdAt: g.createdAt,
      endedAt: g.endedAt!,
    }));
  }

  /**
   * Ends the game as won and credits the payout, in one transaction. The
   * status change is conditional on the step we read and the ledger key is
   * unique per game, so a payout can never happen twice.
   */
  private async settleWin(
    game: MinesGameDocument,
    { revealTile, multX100 }: { revealTile?: number; multX100: number },
  ): Promise<{ game: MinesGameView; balance: number }> {
    const payout = payoutUnits(game.betAmount, multX100);
    return this.connection.transaction(async (session) => {
      const won = await this.games.findOneAndUpdate(
        { _id: game._id, status: 'active', step: game.step },
        {
          ...(revealTile !== undefined && { $push: { revealed: revealTile } }),
          $set: {
            status: 'won',
            step: game.step + (revealTile !== undefined ? 1 : 0),
            multiplierX100: multX100,
            payout,
            endedAt: new Date(),
          },
        },
        { returnDocument: 'after', session, projection: '+bombs +serverSeed' },
      );
      if (!won) throw this.staleMove();
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
      return { game: this.toView(won), balance: unitsToCoins(balance) };
    });
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
    // No commitment yet (the client never asked for one): use a fresh seed.
    return previous?.serverSeed ?? generateServerSeed();
  }

  private async findOwned(
    userId: string,
    gameId: string,
    withSecrets: boolean,
  ): Promise<MinesGameDocument> {
    if (!Types.ObjectId.isValid(gameId))
      throw new NotFoundException('Game not found');
    const query = this.games.findOne({
      _id: new Types.ObjectId(gameId),
      userId: new Types.ObjectId(userId),
    });
    if (withSecrets) query.select('+bombs +serverSeed');
    const game = await query;
    if (!game) throw new NotFoundException('Game not found');
    return game;
  }

  private assertActive(game: MinesGameDocument): void {
    if (game.status !== 'active') {
      throw conflict('game_over', 'This game is already over');
    }
  }

  private staleMove() {
    return conflict('stale_move', 'The game changed; reload it and try again');
  }

  /** The only shape that leaves the server. Secrets only once the game is over. */
  private toView(game: MinesGameDocument): MinesGameView {
    const over = game.status !== 'active';
    const safeLeft = game.tiles - game.minesCount - game.step;
    return {
      id: game.id as string,
      status: game.status,
      bet: unitsToCoins(game.betAmount),
      tiles: game.tiles,
      mines: game.minesCount,
      revealed: [...game.revealed],
      multiplier: game.multiplierX100 / 100,
      nextMultiplier:
        !over && safeLeft > 0
          ? multiplierX100(game.step + 1, game.tiles, game.minesCount) / 100
          : null,
      cashoutAmount:
        over || game.step === 0
          ? 0
          : unitsToCoins(payoutUnits(game.betAmount, game.multiplierX100)),
      payout: unitsToCoins(game.payout),
      hitTile: game.hitTile ?? null,
      canCashOut: !over && game.step > 0,
      fairness: {
        serverSeedHash: game.serverSeedHash,
        clientSeed: game.clientSeed,
        serverSeed: over ? (game.serverSeed ?? null) : null,
      },
      bombs: over && game.bombs ? [...game.bombs] : null,
      createdAt: game.createdAt,
      endedAt: game.endedAt ?? null,
    };
  }
}
