import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { PocketColor } from './roulette.math.js';

@Schema({ _id: false })
export class RouletteBet {
  /** e.g. `red`, `straight:17`, `dozen:2`. */
  @Prop({ type: String, required: true })
  target: string;

  /** Integer units staked on this target. */
  @Prop({ type: Number, required: true })
  amount: number;

  /** Integer units this bet returned (0 if it lost). */
  @Prop({ type: Number, required: true })
  payout: number;
}
const RouletteBetSchema = SchemaFactory.createForClass(RouletteBet);

/**
 * One spin. Settled in the same transaction that creates it: stake debited,
 * number drawn, payout credited. There is no "in progress" state server-side,
 * so a refresh mid-animation can't change or lose anything.
 */
@Schema({ collection: 'roulette_rounds', timestamps: { createdAt: true, updatedAt: false } })
export class RouletteRound {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /**
   * Client-generated id of the Spin request. Unique per user, so a double
   * tap or a retry after a lost response returns this round instead of
   * spinning (and charging) again.
   */
  @Prop({ type: String, required: true })
  requestId: string;

  @Prop({ type: [RouletteBetSchema], required: true })
  bets: RouletteBet[];

  /** Integer units: sum of the bets. */
  @Prop({ type: Number, required: true })
  totalBet: number;

  @Prop({ type: Number, required: true, min: 0, max: 36 })
  number: number;

  @Prop({ type: String, required: true, enum: ['green', 'red', 'black'] })
  color: PocketColor;

  /** Integer units credited (0 if nothing won). */
  @Prop({ type: Number, required: true })
  payout: number;

  /** Revealed with the result: the round is over the moment it exists. */
  @Prop({ type: String, required: true })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;

  @Prop({ type: String, required: true })
  clientSeed: string;

  createdAt: Date;
}

export type RouletteRoundDocument = HydratedDocument<RouletteRound>;
export const RouletteRoundSchema = SchemaFactory.createForClass(RouletteRound);
RouletteRoundSchema.index(
  { userId: 1, requestId: 1 },
  { unique: true, name: 'one_round_per_request' },
);
RouletteRoundSchema.index({ userId: 1, createdAt: -1 });

/** The server seed committed for a user's next spin. */
@Schema({ collection: 'roulette_seeds', timestamps: true })
export class RouletteSeed {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, select: false })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;
}

export const RouletteSeedSchema = SchemaFactory.createForClass(RouletteSeed);
