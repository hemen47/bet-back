import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WalletModule } from '../../wallet/wallet.module.js';
import {
  CrashGame,
  CrashGameSchema,
  CrashSeed,
  CrashSeedSchema,
} from './crash-game.schema.js';
import { CrashController } from './crash.controller.js';
import { CrashService } from './crash.service.js';

/** Crash: the multiplier climbs from 1.00× until a provably fair crash point. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CrashGame.name, schema: CrashGameSchema },
      { name: CrashSeed.name, schema: CrashSeedSchema },
    ]),
    WalletModule,
  ],
  controllers: [CrashController],
  providers: [CrashService],
})
export class CrashModule {}
