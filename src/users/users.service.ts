import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { TelegramWebAppUser } from '../auth/telegram-init-data.js';
import { User, UserDocument } from './user.schema.js';

export interface PublicUser {
  id: string;
  telegramId: number;
  username?: string;
  firstName: string;
  lastName?: string;
  photoUrl?: string;
  languageCode?: string;
  isPremium: boolean;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  /** Creates the user on first sign-in, refreshes the profile afterwards. */
  async upsertFromTelegram(tg: TelegramWebAppUser): Promise<UserDocument> {
    return this.users
      .findOneAndUpdate(
        { telegramId: tg.id },
        {
          $set: {
            username: tg.username,
            firstName: tg.first_name,
            lastName: tg.last_name,
            languageCode: tg.language_code,
            photoUrl: tg.photo_url,
            isPremium: tg.is_premium ?? false,
            lastLoginAt: new Date(),
          },
          $setOnInsert: { telegramId: tg.id },
        },
        { upsert: true, returnDocument: 'after', runValidators: true },
      )
      .orFail();
  }

  async findById(id: string): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.users.findById(id);
  }

  async getById(id: string): Promise<UserDocument> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  toPublic(user: UserDocument): PublicUser {
    return {
      id: user.id as string,
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      photoUrl: user.photoUrl,
      languageCode: user.languageCode,
      isPremium: user.isPremium,
      createdAt: user.createdAt,
    };
  }
}
