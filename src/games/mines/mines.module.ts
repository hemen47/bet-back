import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WalletModule } from '../../wallet/wallet.module.js';
import { MinesGame, MinesGameSchema } from './mines-game.schema.js';
import { MinesSeed, MinesSeedSchema } from './mines-seed.schema.js';
import { MinesController } from './mines.controller.js';
import { MinesService } from './mines.service.js';

/** Mines: 3×3 grid, 2 bombs. Each game is a self-contained module like this one. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MinesGame.name, schema: MinesGameSchema },
      { name: MinesSeed.name, schema: MinesSeedSchema },
    ]),
    WalletModule,
  ],
  controllers: [MinesController],
  providers: [MinesService],
})
export class MinesModule {}
