import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * The server seed committed for a user's *next* Mines game. Its hash is
 * public before the player picks a client seed; starting a game consumes it
 * and commits a fresh one.
 */
@Schema({ collection: 'mines_seeds', timestamps: true })
export class MinesSeed {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, select: false })
  serverSeed: string;

  @Prop({ type: String, required: true })
  serverSeedHash: string;
}

export type MinesSeedDocument = HydratedDocument<MinesSeed>;
export const MinesSeedSchema = SchemaFactory.createForClass(MinesSeed);
