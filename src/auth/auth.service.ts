import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TokenService } from '@nestjs/authentication';
import type { Env } from '../config/env.schema.js';
import { UsersService, type PublicUser } from '../users/users.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { InitDataError, validateInitData } from './telegram-init-data.js';

export interface SignInResult {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
  balance: number;
  /** `start_param` from the Mini App link, e.g. for future referral codes. */
  startParam?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly wallet: WalletService,
  ) {}

  /**
   * Exchanges `Telegram.WebApp.initData` for an access token. No separate
   * registration: the first valid sign-in creates the user and the wallet.
   */
  async signInWithTelegram(initData: string): Promise<SignInResult> {
    let data;
    try {
      data = validateInitData(
        initData,
        this.config.get('TELEGRAM_BOT_TOKEN', { infer: true }),
        this.config.get('TELEGRAM_INIT_DATA_MAX_AGE', { infer: true }),
      );
    } catch (error) {
      if (error instanceof InitDataError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }

    const user = await this.users.upsertFromTelegram(data.user);
    await this.wallet.ensureWallet(user.id as string);

    const { accessToken, expiresIn } = await this.tokens.issue(
      user.id as string,
      { method: 'telegram', claims: { tid: user.telegramId } },
    );

    return {
      accessToken,
      expiresIn,
      user: this.users.toPublic(user),
      balance: await this.wallet.getBalance(user.id as string),
      startParam: data.startParam,
    };
  }
}
