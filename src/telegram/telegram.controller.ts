import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Update } from 'grammy/types';
import type { Env } from '../config/env.schema.js';
import { TelegramBotService } from './telegram-bot.service.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

@Public()
@SkipThrottle()
@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly bot: TelegramBotService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Telegram posts bot updates here (webhook mode only). */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: Update,
  ): Promise<void> {
    if (!this.bot.isWebhook) throw new NotFoundException();
    const expected = this.config.get('TELEGRAM_WEBHOOK_SECRET', {
      infer: true,
    })!;
    if (!secret || !timingSafeEqual(digest(secret), digest(expected))) {
      throw new UnauthorizedException();
    }
    try {
      await this.bot.handleUpdate(update);
    } catch (error) {
      // Answer 200 anyway so Telegram doesn't redeliver a broken update forever.
      this.logger.error('Failed to handle update', error as Error);
    }
  }
}
