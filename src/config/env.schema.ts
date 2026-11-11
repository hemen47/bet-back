import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

/** Treats an empty value (`KEY=` in .env) as not set. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(47311),
    /** Comma-separated origins allowed to call the API (the Next.js app). */
    CORS_ORIGINS: csv,
    /** `true` when running behind a reverse proxy (nginx, Caddy, Traefik). */
    TRUST_PROXY: bool,

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

    TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
    /** `webhook` in production, `polling` for local development, `off` to not run the bot. */
    TELEGRAM_BOT_MODE: z.enum(['webhook', 'polling', 'off']).default('polling'),
    /** Public HTTPS base URL of this API, e.g. https://api.example.com (webhook mode). */
    TELEGRAM_WEBHOOK_URL: optional(z.url()),
    /** Random string Telegram echoes back in `X-Telegram-Bot-Api-Secret-Token`. */
    TELEGRAM_WEBHOOK_SECRET: optional(
      z
        .string()
        .regex(
          /^[A-Za-z0-9_-]{16,256}$/,
          'use 16-256 chars of A-Z a-z 0-9 _ -',
        ),
    ),
    /** The Next.js Mini App URL opened by the bot's button. */
    MINI_APP_URL: optional(z.url()),
    /** How old Telegram initData may be when exchanged for a token. */
    TELEGRAM_INIT_DATA_MAX_AGE: z.coerce
      .number()
      .int()
      .positive()
      .default(86_400),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_TTL: z
      .string()
      .regex(/^\d+(ms|s|m|h|d|w)$/, 'e.g. 15m, 12h, 1d')
      .default('12h')
      .transform((v) => v as `${number}${'ms' | 's' | 'm' | 'h' | 'd' | 'w'}`),

    /** Coins granted on first sign-in. */
    STARTING_BALANCE: z.coerce.number().int().nonnegative().default(1000),
    /** Coins granted by the daily reward. */
    DAILY_REWARD_AMOUNT: z.coerce.number().int().positive().default(100),
  })
  .superRefine((env, ctx) => {
    if (env.TELEGRAM_BOT_MODE === 'webhook') {
      if (!env.TELEGRAM_WEBHOOK_URL)
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_WEBHOOK_URL'],
          message: 'required when TELEGRAM_BOT_MODE=webhook',
        });
      if (!env.TELEGRAM_WEBHOOK_SECRET)
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_WEBHOOK_SECRET'],
          message: 'required when TELEGRAM_BOT_MODE=webhook',
        });
    }
  });

export type Env = z.infer<typeof envSchema>;
