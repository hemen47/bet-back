import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { z } from 'zod';
import { WalletService } from './wallet.service.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Transaction id: returns entries older than it (cursor pagination). */
  before: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
});

@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  async balance(@CurrentUser('id') userId: string) {
    return { balance: await this.wallet.getBalance(userId) };
  }

  @Get('transactions')
  async transactions(
    @CurrentUser('id') userId: string,
    @Query({ schema: listQuery }) query: z.infer<typeof listQuery>,
  ) {
    return {
      items: await this.wallet.listTransactions(
        userId,
        query.limit,
        query.before,
      ),
    };
  }
}
