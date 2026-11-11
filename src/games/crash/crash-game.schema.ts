import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const CRASH_STATUSES = ['running', 'cashed_out', 'crashed'] as const;
export type CrashStatus = (typeof CRASH_STATUSES)[number];

/**
 * One Crash round for one player. The curve is a pure function of time
 * since `startsAt`, so the document only stores when the round started,
 * where it will crash (secret) and how it ended.
 */
@Schema({ collection: 'crash_games', timestamps: true })
export class CrashGame {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** `running` covers the short waiting phase before `startsAt` too. */
  @Prop({ type: String, required: true, enum: CRASH_STATUSES, default: 'running' })
  status: CrashStatus;

  /** Integer units. */
  @Prop({ type: Number, required: true })
  betAmount: number;

  /** Auto cash-out target in hundredths, if set. */
  @Prop({ type: Number })
  autoCashoutX100?: number;

  /** Secret until the round is over. Never selected by default. */
  @Prop({ type: Number, required: true, select: false })
  crashPointX100: number;

  /** Secret until the round is over. Never selected by default. */
  @Prop({ type: String, required: true, select: false })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;

  @Prop({ type: String, required: true })
  clientSeed: string;

  /** Lift-off: the multiplier is 1.00× here and grows from it. */
  @Prop({ type: Date, required: true })
  startsAt: Date;

  /** Multiplier the player cashed out at (manual or auto), in hundredths. */
  @Prop({ type: Number })
  cashoutX100?: number;

  /** Integer units credited; 0 when crashed. */
  @Prop({ type: Number, default: 0 })
  payout: number;

  @Prop({ type: Date })
  endedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type CrashGameDocument = HydratedDocument<CrashGame>;
export const CrashGameSchema = SchemaFactory.createForClass(CrashGame);

// One running round per user: a double tap or a second tab can't bet twice.
CrashGameSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'running' },
    name: 'one_running_round_per_user',
  },
);
CrashGameSchema.index({ userId: 1, endedAt: -1 });

/** The server seed committed for a user's next Crash round. */
@Schema({ collection: 'crash_seeds', timestamps: true })
export class CrashSeed {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, select: false })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;
}

export const CrashSeedSchema = SchemaFactory.createForClass(CrashSeed);
