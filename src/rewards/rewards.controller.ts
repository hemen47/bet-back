import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { DailyRewardService } from './daily-reward.service.js';

@Controller('rewards')
export class RewardsController {
  constructor(private readonly daily: DailyRewardService) {}

  @Get('daily')
  status(@CurrentUser('id') userId: string) {
    return this.daily.status(userId);
  }

  @Post('daily/claim')
  @HttpCode(200)
  claim(@CurrentUser('id') userId: string) {
    return this.daily.claim(userId);
  }
}
