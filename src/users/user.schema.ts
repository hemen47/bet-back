import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'users', timestamps: true })
export class User {
  @Prop({ type: Number, required: true, unique: true })
  telegramId: number;

  @Prop({ type: String })
  username?: string;

  @Prop({ type: String, required: true })
  firstName: string;

  @Prop({ type: String })
  lastName?: string;

  @Prop({ type: String })
  languageCode?: string;

  @Prop({ type: String })
  photoUrl?: string;

  @Prop({ type: Boolean, default: false })
  isPremium: boolean;

  @Prop({ type: Date })
  lastLoginAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
