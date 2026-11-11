import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard } from 'grammy';
import type { Update } from 'grammy/types';
import type { Env } from '../config/env.schema.js';

/**
 * The bot is only the entry point: /start answers with a button that opens
 * the Mini App, and the chat menu button opens it too. Everything else
 * happens over the REST API.
 */
@Injectable()
export class TelegramBotService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly bot: Bot;
  private readonly mode: Env['TELEGRAM_BOT_MODE'];
  private readonly miniAppUrl?: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.mode = config.get('TELEGRAM_BOT_MODE', { infer: true });
    this.miniAppUrl = config.get('MINI_APP_URL', { infer: true });
    this.bot = new Bot(config.get('TELEGRAM_BOT_TOKEN', { infer: true }));
    this.registerHandlers();
  }

  get isWebhook(): boolean {
    return this.mode === 'webhook';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode === 'off') {
      this.logger.log('Telegram bot disabled (TELEGRAM_BOT_MODE=off)');
      return;
    }
    try {
      await this.bot.init();
      await this.setMenuButton();

      if (this.mode === 'webhook') {
        const base = this.config.get('TELEGRAM_WEBHOOK_URL', { infer: true })!;
        const url = new URL(
          'telegram/webhook',
          base.endsWith('/') ? base : `${base}/`,
        );
        await this.bot.api.setWebhook(url.toString(), {
          secret_token: this.config.get('TELEGRAM_WEBHOOK_SECRET', {
            infer: true,
          }),
          allowed_updates: ['message', 'callback_query'],
        });
        this.logger.log(
          `@${this.bot.botInfo.username}: webhook set to ${url.toString()}`,
        );
      } else {
        await this.bot.api.deleteWebhook();
        // Runs until stop(); not awaited on purpose.
        void this.bot
          .start({
            drop_pending_updates: true,
            allowed_updates: ['message', 'callback_query'],
          })
          .catch((error: unknown) =>
            this.logger.error('Polling stopped', error as Error),
          );
        this.logger.log(`@${this.bot.botInfo.username}: long polling started`);
      }
    } catch (error) {
      // A Telegram outage must not take the game API down.
      this.logger.error('Telegram bot failed to start', error as Error);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.mode === 'polling' && this.bot.isRunning()) await this.bot.stop();
  }

  async handleUpdate(update: Update): Promise<void> {
    await this.bot.handleUpdate(update);
  }

  private registerHandlers(): void {
    this.bot.command('start', async (ctx) => {
      const name = ctx.from?.first_name ?? 'there';
      const text =
        `👋 Hi ${name}!\n\n` +
        `Pick a game:\n` +
        `💣 Mines: uncover gems, dodge the bombs, cash out any time.\n` +
        `🚀 Crash: the multiplier climbs. Cash out before it crashes.\n` +
        `🎡 Roulette: European wheel, red/black, numbers and more.\n` +
        `💩 Poop: pick 💩 or 😆, climb 5 stages up to 30.40×.\n\n` +
        `🎁 You start with 1,000 free coins, plus a daily reward.`;
      if (!this.miniAppUrl) {
        await ctx.reply(`${text}\n\n(The game URL isn't set up yet.)`);
        return;
      }
      await ctx.reply(text, {
        reply_markup: new InlineKeyboard().webApp(
          '🎮 Open games',
          this.miniAppUrl,
        ),
      });
    });

    this.bot.command('help', (ctx) =>
      ctx.reply(
        'Tap "Play now" or the menu button to open the game. Coins are virtual and have no real value.',
      ),
    );

    this.bot.catch((error) => {
      this.logger.error(
        `Update ${error.ctx.update.update_id} failed`,
        error.error as Error,
      );
    });
  }

  private async setMenuButton(): Promise<void> {
    if (!this.miniAppUrl) return;
    await this.bot.api.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: 'Play',
        web_app: { url: this.miniAppUrl },
      },
    });
  }
}
