import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** One user's progress on one mission for one UTC day. */
@Schema({ collection: 'mission_progress', timestamps: true })
export class MissionProgress {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** UTC day, `YYYY-MM-DD`. */
  @Prop({ type: String, required: true })
  day: string;

  @Prop({ type: String, required: true })
  missionId: string;

  @Prop({ type: Number, required: true, default: 0 })
  progress: number;

  /** Set once, when the reward is paid. */
  @Prop({ type: Date, default: null })
  claimedAt: Date | null;
}

export type MissionProgressDocument = HydratedDocument<MissionProgress>;
export const MissionProgressSchema = SchemaFactory.createForClass(MissionProgress);
MissionProgressSchema.index(
  { userId: 1, day: 1, missionId: 1 },
  { unique: true, name: 'one_progress_per_mission_day' },
);
