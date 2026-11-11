import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { Model, Types } from 'mongoose';
import { coinsToUnits, unitsToCoins } from '../common/money.js';
import { isDuplicateKeyError } from '../common/mongo.js';
import type { Env } from '../config/env.schema.js';
import {
  TransactionType,
  WalletTransaction,
} from './wallet-transaction.schema.js';
import { Wallet } from './wallet.schema.js';

export class InsufficientBalanceException extends BadRequestException {
  constructor() {
    super({
      statusCode: 400,
      error: 'insufficient_balance',
      message: 'Insufficient balance',
    });
  }
}

export interface LedgerRef {
  type: TransactionType;
  /** Unique name of the event (see WalletTransaction.key). */
  key: string;
  game?: string;
  gameId?: Types.ObjectId;
}

export interface PublicTransaction {
  id: string;
  type: TransactionType;
  amount: number;
  balanceAfter: number;
  game?: string;
  gameId?: string;
  createdAt: Date;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Wallet.name) private readonly wallets: Model<Wallet>,
    @InjectModel(WalletTransaction.name)
    private readonly transactions: Model<WalletTransaction>,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Creates the wallet with the starting balance, once. Safe to call on
   * every sign-in and concurrently: the unique `userId` and ledger `key`
   * make the second caller a no-op.
   */
  async ensureWallet(userId: string): Promise<void> {
    const uid = new Types.ObjectId(userId);
    if (await this.wallets.exists({ userId: uid })) return;

    const starting = coinsToUnits(
      this.config.get('STARTING_BALANCE', { infer: true }),
    );
    try {
      await this.connection.transaction(async (session) => {
        await this.wallets.create([{ userId: uid, balance: starting }], {
          session,
        });
        await this.transactions.create(
          [
            {
              userId: uid,
              type: 'signup_bonus',
              amount: starting,
              balanceAfter: starting,
              key: `signup:${userId}`,
            },
          ],
          { session },
        );
      });
      this.logger.log(`Wallet created for ${userId}`);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  /**
   * Takes `amount` units, atomically refusing to go below zero. Must run
   * inside the caller's transaction so the ledger entry and whatever the
   * money pays for are committed together.
   */
  async debit(
    userId: Types.ObjectId,
    amount: number,
    ref: LedgerRef,
    session: ClientSession,
  ): Promise<number> {
    this.assertAmount(amount);
    const wallet = await this.wallets.findOneAndUpdate(
      { userId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { returnDocument: 'after', session },
    );
    if (!wallet) {
      const exists = await this.wallets.exists({ userId }).session(session);
      if (!exists) throw new NotFoundException('Wallet not found');
      throw new InsufficientBalanceException();
    }
    await this.record(userId, -amount, wallet.balance, ref, session);
    return wallet.balance;
  }

  /** Adds `amount` units. Must run inside the caller's transaction. */
  async credit(
    userId: Types.ObjectId,
    amount: number,
    ref: LedgerRef,
    session: ClientSession,
  ): Promise<number> {
    this.assertAmount(amount);
    const wallet = await this.wallets.findOneAndUpdate(
      { userId },
      { $inc: { balance: amount } },
      { returnDocument: 'after', session },
    );
    if (!wallet) throw new NotFoundException('Wallet not found');
    await this.record(userId, amount, wallet.balance, ref, session);
    return wallet.balance;
  }

  /** Whether the event named `key` already moved money. */
  async hasTransaction(key: string): Promise<boolean> {
    return (await this.transactions.exists({ key })) !== null;
  }

  /** Runs `fn` in a Mongo transaction (retried on transient errors). */
  transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.connection.transaction(fn);
  }

  /** Balance in units. */
  async getBalanceUnits(userId: string): Promise<number> {
    const wallet = await this.wallets
      .findOne({ userId: new Types.ObjectId(userId) })
      .lean();
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet.balance;
  }

  async getBalance(userId: string): Promise<number> {
    return unitsToCoins(await this.getBalanceUnits(userId));
  }

  async listTransactions(
    userId: string,
    limit: number,
    before?: string,
  ): Promise<PublicTransaction[]> {
    const filter: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
    };
    if (before && Types.ObjectId.isValid(before)) {
      filter._id = { $lt: new Types.ObjectId(before) };
    }
    const rows = await this.transactions
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .lean();
    return rows.map((row) => ({
      id: row._id.toString(),
      type: row.type,
      amount: unitsToCoins(row.amount),
      balanceAfter: unitsToCoins(row.balanceAfter),
      game: row.game,
      gameId: row.gameId?.toString(),
      createdAt: row.createdAt,
    }));
  }

  private async record(
    userId: Types.ObjectId,
    amount: number,
    balanceAfter: number,
    ref: LedgerRef,
    session: ClientSession,
  ): Promise<void> {
    // A duplicate `key` throws E11000 here and aborts the whole transaction,
    // undoing the balance change above.
    await this.transactions.create(
      [
        {
          userId,
          type: ref.type,
          amount,
          balanceAfter,
          key: ref.key,
          game: ref.game,
          gameId: ref.gameId,
        },
      ],
      { session },
    );
  }

  private assertAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Invalid wallet amount: ${amount}`);
    }
  }
}
