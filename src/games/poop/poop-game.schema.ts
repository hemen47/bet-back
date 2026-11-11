import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { POOP_CHOICES, type PoopChoice } from './poop.math.js';

export const POOP_STATUSES = ['active', 'won', 'lost'] as const;
export type PoopStatus = (typeof POOP_STATUSES)[number];

@Schema({ _id: false })
export class PoopPick {
  @Prop({ type: String, required: true, enum: POOP_CHOICES })
  choice: PoopChoice;

  @Prop({ type: Boolean, required: true })
  correct: boolean;
}
const PoopPickSchema = SchemaFactory.createForClass(PoopPick);

@Schema({ collection: 'poop_games', timestamps: true })
export class PoopGame {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: POOP_STATUSES, default: 'active' })
  status: PoopStatus;

  /** Integer units. */
  @Prop({ type: Number, required: true })
  betAmount: number;

  /** Correct answer per stage. Secret until the round ends. Never selected by default. */
  @Prop({ type: [String], required: true, select: false })
  answers: PoopChoice[];

  /** Secret until the round ends. Never selected by default. */
  @Prop({ type: String, required: true, select: false })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;

  @Prop({ type: String, required: true })
  clientSeed: string;

  /** Every pick in order; only the last one can be wrong. */
  @Prop({ type: [PoopPickSchema], default: [] })
  picks: PoopPick[];

  /**
   * Correct picks so far (= stages completed). Every write is conditional on
   * the step the request read, so two concurrent picks can't both apply.
   */
  @Prop({ type: Number, required: true, default: 0 })
  step: number;

  /** Current multiplier in hundredths; final once ended (0 on loss). */
  @Prop({ type: Number, required: true, default: 100 })
  multiplierX100: number;

  /** Integer units credited; 0 on loss. */
  @Prop({ type: Number, default: 0 })
  payout: number;

  @Prop({ type: Date })
  endedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type PoopGameDocument = HydratedDocument<PoopGame>;
export const PoopGameSchema = SchemaFactory.createForClass(PoopGame);

// At most one active round per user.
PoopGameSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_poop_per_user' },
);
PoopGameSchema.index({ userId: 1, endedAt: -1 });

/** The server seed committed for a user's next Poop round. */
@Schema({ collection: 'poop_seeds', timestamps: true })
export class PoopSeed {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, select: false })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;
}

export const PoopSeedSchema = SchemaFactory.createForClass(PoopSeed);
