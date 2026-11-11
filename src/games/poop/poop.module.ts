import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MissionsModule } from '../../missions/missions.module.js';
import { WalletModule } from '../../wallet/wallet.module.js';
import { PoopGame, PoopGameSchema, PoopSeed, PoopSeedSchema } from './poop-game.schema.js';
import { PoopController } from './poop.controller.js';
import { PoopService } from './poop.service.js';

/** Poop: 5 stages of 💩 / 😆, 50/50 each, cash out after any correct pick. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PoopGame.name, schema: PoopGameSchema },
      { name: PoopSeed.name, schema: PoopSeedSchema },
    ]),
    WalletModule,
    MissionsModule,
  ],
  controllers: [PoopController],
  providers: [PoopService],
})
export class PoopModule {}
