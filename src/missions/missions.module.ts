import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WalletModule } from '../wallet/wallet.module.js';
import { MissionProgress, MissionProgressSchema } from './mission-progress.schema.js';
import { MissionsController } from './missions.controller.js';
import { MissionsService } from './missions.service.js';

/** Daily missions. Games import this module and report progress to MissionsService. */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: MissionProgress.name, schema: MissionProgressSchema }]),
    WalletModule,
  ],
  controllers: [MissionsController],
  providers: [MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
