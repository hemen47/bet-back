import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WalletModule } from '../../wallet/wallet.module.js';
import {
  RouletteRound,
  RouletteRoundSchema,
  RouletteSeed,
  RouletteSeedSchema,
} from './roulette-round.schema.js';
import { RouletteController } from './roulette.controller.js';
import { RouletteService } from './roulette.service.js';

/** European roulette: single zero, inside and outside bets, settled per spin. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RouletteRound.name, schema: RouletteRoundSchema },
      { name: RouletteSeed.name, schema: RouletteSeedSchema },
    ]),
    WalletModule,
  ],
  controllers: [RouletteController],
  providers: [RouletteService],
})
export class RouletteModule {}
