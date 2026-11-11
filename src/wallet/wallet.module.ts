import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  WalletTransaction,
  WalletTransactionSchema,
} from './wallet-transaction.schema.js';
import { WalletController } from './wallet.controller.js';
import { Wallet, WalletSchema } from './wallet.schema.js';
import { WalletService } from './wallet.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wallet.name, schema: WalletSchema },
      { name: WalletTransaction.name, schema: WalletTransactionSchema },
    ]),
  ],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
