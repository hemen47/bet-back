import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const TRANSACTION_TYPES = [
  'signup_bonus',
  'daily_reward',
  'mission_reward',
  'bet',
  'win',
  'refund',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Append-only ledger. Every balance change writes exactly one entry in the
 * same Mongo transaction as the balance update.
 *
 * `key` is unique: it names the event that caused the entry
 * (`mines:<gameId>:bet`, `mines:<gameId>:payout`, `daily:<user>:<day>`), so
 * the same event can never move money twice, even if two requests race.
 */
@Schema({
  collection: 'wallet_transactions',
  timestamps: { createdAt: true, updatedAt: false },
})
export class WalletTransaction {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: TRANSACTION_TYPES })
  type: TransactionType;

  /** Signed integer units: negative for debits. */
  @Prop({ type: Number, required: true })
  amount: number;

  @Prop({ type: Number, required: true })
  balanceAfter: number;

  @Prop({ type: String, required: true, unique: true })
  key: string;

  /** Game module that caused it, e.g. `mines`. */
  @Prop({ type: String })
  game?: string;

  @Prop({ type: Types.ObjectId })
  gameId?: Types.ObjectId;

  createdAt: Date;
}

export type WalletTransactionDocument = HydratedDocument<WalletTransaction>;
export const WalletTransactionSchema =
  SchemaFactory.createForClass(WalletTransaction);
WalletTransactionSchema.index({ userId: 1, createdAt: -1 });
