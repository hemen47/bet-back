import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** One wallet per user, shared by every game. Amounts are integer units (see common/money.ts). */
@Schema({ collection: 'wallets', timestamps: true })
export class Wallet {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'balance must be an integer',
    },
  })
  balance: number;

  createdAt: Date;
  updatedAt: Date;
}

export type WalletDocument = HydratedDocument<Wallet>;
export const WalletSchema = SchemaFactory.createForClass(Wallet);
