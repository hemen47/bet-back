import { Module } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service.js';
import { TelegramController } from './telegram.controller.js';

@Module({
  controllers: [TelegramController],
  providers: [TelegramBotService],
})
export class TelegramModule {}
