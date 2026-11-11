import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const MINES_STATUSES = ['active', 'won', 'lost'] as const;
export type MinesStatus = (typeof MINES_STATUSES)[number];

@Schema({ collection: 'mines_games', timestamps: true })
export class MinesGame {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: MINES_STATUSES,
    default: 'active',
  })
  status: MinesStatus;

  /** Integer units. */
  @Prop({ type: Number, required: true })
  betAmount: number;

  @Prop({ type: Number, required: true })
  tiles: number;

  @Prop({ type: Number, required: true })
  minesCount: number;

  /** Secret until the game ends. Never selected by default. */
  @Prop({ type: [Number], required: true, select: false })
  bombs: number[];

  /** Secret until the game ends. Never selected by default. */
  @Prop({ type: String, required: true, select: false })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;

  @Prop({ type: String, required: true })
  clientSeed: string;

  /** Safe tiles uncovered, in order. */
  @Prop({ type: [Number], default: [] })
  revealed: number[];

  /**
   * Number of moves applied (= revealed.length). Every write is conditional
   * on the step the request read, so two concurrent moves can't both apply.
   */
  @Prop({ type: Number, required: true, default: 0 })
  step: number;

  /** Current multiplier in hundredths; final multiplier once ended (0 on loss). */
  @Prop({ type: Number, required: true, default: 100 })
  multiplierX100: number;

  /** Integer units credited on cash-out; 0 on loss. */
  @Prop({ type: Number, default: 0 })
  payout: number;

  /** The bomb the player hit. */
  @Prop({ type: Number })
  hitTile?: number;

  @Prop({ type: Date })
  endedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type MinesGameDocument = HydratedDocument<MinesGame>;
export const MinesGameSchema = SchemaFactory.createForClass(MinesGame);

// At most one active game per user: a second start (double tap, two tabs)
// fails on this index inside the transaction, before any money moves.
MinesGameSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
    name: 'one_active_game_per_user',
  },
);
MinesGameSchema.index({ userId: 1, endedAt: -1 });
