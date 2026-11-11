import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { UsersService } from '../users/users.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { Env } from '../config/env.schema.js';
import { AuthService } from './auth.service.js';
import { signInitData } from './telegram-init-data.js';

const telegramSignIn = z.object({
  /** `window.Telegram.WebApp.initData`, sent as-is. */
  initData: z.string().min(1).max(4096),
});

const devSignIn = z.object({
  telegramId: z.number().int().positive().max(9_999_999_999).optional(),
  firstName: z.string().min(1).max(64).optional(),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('telegram')
  @HttpCode(200)
  signIn(
    @Body({ schema: telegramSignIn }) body: z.infer<typeof telegramSignIn>,
  ) {
    return this.auth.signInWithTelegram(body.initData);
  }

  /**
   * Development only: signs initData for a fake user with the bot token and
   * runs the normal sign-in, so the Mini App can be opened in a browser.
   * Responds 404 unless NODE_ENV=development.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('dev')
  @HttpCode(200)
  devSignIn(@Body({ schema: devSignIn }) body: z.infer<typeof devSignIn>) {
    if (this.config.get('NODE_ENV', { infer: true }) !== 'development') {
      throw new NotFoundException();
    }
    const id = body.telegramId ?? 100_000_001;
    const initData = signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: 'dev',
        user: JSON.stringify({
          id,
          first_name: body.firstName ?? 'Dev',
          username: `dev${id}`,
        }),
      },
      this.config.get('TELEGRAM_BOT_TOKEN', { infer: true }),
    );
    return this.auth.signInWithTelegram(initData);
  }

  @Get('me')
  async me(@CurrentUser('id') userId: string) {
    const user = await this.users.getById(userId);
    return {
      user: this.users.toPublic(user),
      balance: await this.wallet.getBalance(userId),
    };
  }
}
