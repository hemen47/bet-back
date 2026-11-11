import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module.js';
import { DailyRewardService } from './daily-reward.service.js';
import { RewardsController } from './rewards.controller.js';

@Module({
  imports: [WalletModule],
  controllers: [RewardsController],
  providers: [DailyRewardService],
})
export class RewardsModule {}
