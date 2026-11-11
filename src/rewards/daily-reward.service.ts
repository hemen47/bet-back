import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { coinsToUnits, unitsToCoins } from '../common/money.js';
import { isDuplicateKeyError } from '../common/mongo.js';
import type { Env } from '../config/env.schema.js';
import { WalletService } from '../wallet/wallet.service.js';

export interface DailyRewardStatus {
  amount: number;
  available: boolean;
  /** Next UTC midnight, when the next reward can be claimed. */
  nextClaimAt: Date;
}

/**
 * One reward per UTC calendar day. The ledger key `daily:<user>:<day>` is
 * unique, so concurrent claims can't pay twice.
 */
@Injectable()
export class DailyRewardService {
  constructor(
    private readonly wallet: WalletService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async status(userId: string, now = new Date()): Promise<DailyRewardStatus> {
    const claimed = await this.wallet.hasTransaction(this.key(userId, now));
    return {
      amount: this.amount(),
      available: !claimed,
      nextClaimAt: claimed ? this.nextUtcMidnight(now) : now,
    };
  }

  async claim(
    userId: string,
    now = new Date(),
  ): Promise<{ amount: number; balance: number; nextClaimAt: Date }> {
    const units = coinsToUnits(this.amount());
    try {
      const balance = await this.wallet.transaction((session) =>
        this.wallet.credit(
          new Types.ObjectId(userId),
          units,
          { type: 'daily_reward', key: this.key(userId, now) },
          session,
        ),
      );
      return {
        amount: this.amount(),
        balance: unitsToCoins(balance),
        nextClaimAt: this.nextUtcMidnight(now),
      };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException({
          statusCode: 409,
          error: 'already_claimed',
          message: 'Daily reward already claimed today',
          nextClaimAt: this.nextUtcMidnight(now),
        });
      }
      throw error;
    }
  }

  private amount(): number {
    return this.config.get('DAILY_REWARD_AMOUNT', { infer: true });
  }

  private key(userId: string, now: Date): string {
    return `daily:${userId}:${now.toISOString().slice(0, 10)}`;
  }

  private nextUtcMidnight(now: Date): Date {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
  }
}
