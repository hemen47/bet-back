import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { coinsToUnits, unitsToCoins } from '../common/money.js';
import { isDuplicateKeyError } from '../common/mongo.js';
import { WalletService } from '../wallet/wallet.service.js';
import { MissionProgress } from './mission-progress.schema.js';
import { missionById, MISSIONS, type MissionDef } from './missions.definitions.js';

export interface MissionView extends MissionDef {
  progress: number;
  completed: boolean;
  claimed: boolean;
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);
const nextUtcMidnight = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/**
 * Daily missions: progress reported by games, rewards claimed once.
 * Reporting is best effort (it never fails a game action); claiming is a
 * conditional update plus a ledger entry with a unique key, in one
 * transaction, so a reward can't be paid twice.
 */
@Injectable()
export class MissionsService {
  private readonly logger = new Logger(MissionsService.name);

  constructor(
    @InjectModel(MissionProgress.name) private readonly progress: Model<MissionProgress>,
    private readonly wallet: WalletService,
  ) {}

  async list(userId: string, now = new Date()): Promise<{ items: MissionView[]; resetsAt: Date }> {
    const rows = await this.progress
      .find({ userId: new Types.ObjectId(userId), day: utcDay(now) })
      .lean();
    const byId = new Map(rows.map((r) => [r.missionId, r]));
    return {
      items: MISSIONS.map((m) => {
        const row = byId.get(m.id);
        const value = Math.min(m.target, row?.progress ?? 0);
        return { ...m, progress: value, completed: value >= m.target, claimed: !!row?.claimedAt };
      }),
      resetsAt: nextUtcMidnight(now),
    };
  }

  /** Adds `by` to a counter mission (e.g. rounds played). */
  async increment(userId: Types.ObjectId | string, missionId: string, by = 1): Promise<void> {
    await this.report(userId, missionId, { $inc: { progress: by } });
  }

  /** Raises a "best so far" mission to `value` if higher (e.g. stages in one round). */
  async raiseTo(userId: Types.ObjectId | string, missionId: string, value: number): Promise<void> {
    await this.report(userId, missionId, { $max: { progress: value } });
  }

  async claim(
    userId: string,
    missionId: string,
    now = new Date(),
  ): Promise<{ reward: number; balance: number }> {
    const mission = missionById(missionId);
    if (!mission) throw new NotFoundException('Mission not found');
    const uid = new Types.ObjectId(userId);
    const day = utcDay(now);

    try {
      const balance = await this.wallet.transaction(async (session) => {
        const row = await this.progress.findOneAndUpdate(
          { userId: uid, day, missionId, progress: { $gte: mission.target }, claimedAt: null },
          { $set: { claimedAt: now } },
          { session, returnDocument: 'after' },
        );
        if (!row) {
          const existing = await this.progress.findOne({ userId: uid, day, missionId }).session(session);
          if (existing?.claimedAt) {
            throw new ConflictException({ statusCode: 409, error: 'already_claimed', message: 'Reward already claimed today' });
          }
          throw new BadRequestException({ statusCode: 400, error: 'mission_incomplete', message: 'Mission not completed yet' });
        }
        return this.wallet.credit(
          uid,
          coinsToUnits(mission.reward),
          { type: 'mission_reward', key: `mission:${userId}:${day}:${missionId}` },
          session,
        );
      });
      return { reward: mission.reward, balance: unitsToCoins(balance) };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException({ statusCode: 409, error: 'already_claimed', message: 'Reward already claimed today' });
      }
      throw error;
    }
  }

  private async report(userId: Types.ObjectId | string, missionId: string, update: object) {
    if (!missionById(missionId)) return;
    const filter = {
      userId: new Types.ObjectId(userId),
      day: utcDay(new Date()),
      missionId,
    };
    try {
      await this.progress.updateOne(filter, { ...update, $setOnInsert: { claimedAt: null } }, { upsert: true });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // Two first reports raced on the upsert: the row exists now, apply again.
        await this.progress.updateOne(filter, update).catch(() => undefined);
        return;
      }
      // Missions must never break a game action.
      this.logger.warn(`Mission ${missionId} progress not recorded: ${(error as Error).message}`);
    }
  }
}
