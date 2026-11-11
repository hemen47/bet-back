import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface ValidatedInitData {
  user: TelegramWebAppUser;
  authDate: Date;
  startParam?: string;
  queryId?: string;
}

export class InitDataError extends Error {}

/**
 * Validates `Telegram.WebApp.initData` as described in
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   secret_key = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   hash       = hex(HMAC_SHA256(key = secret_key, data = data_check_string))
 *
 * where data_check_string is every field except `hash`, sorted by key,
 * formatted `key=value` and joined with "\n".
 */
export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now: Date = new Date(),
): ValidatedInitData {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new InitDataError('initData has no valid hash');
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const expected = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest();

  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) {
    throw new InitDataError('initData signature mismatch');
  }

  const authDateSeconds = Number(params.get('auth_date'));
  if (!Number.isInteger(authDateSeconds) || authDateSeconds <= 0) {
    throw new InitDataError('initData has no auth_date');
  }
  const ageSeconds = now.getTime() / 1000 - authDateSeconds;
  if (ageSeconds > maxAgeSeconds) {
    throw new InitDataError('initData expired');
  }
  // A little clock skew is fine; a date far in the future is not.
  if (ageSeconds < -300) {
    throw new InitDataError('initData auth_date is in the future');
  }

  const rawUser = params.get('user');
  if (!rawUser) throw new InitDataError('initData has no user');
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(rawUser) as TelegramWebAppUser;
  } catch {
    throw new InitDataError('initData user is not JSON');
  }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) {
    throw new InitDataError('initData user has no id');
  }

  return {
    user,
    authDate: new Date(authDateSeconds * 1000),
    startParam: params.get('start_param') ?? undefined,
    queryId: params.get('query_id') ?? undefined,
  };
}

/**
 * Builds a signed initData string, the way Telegram does. For tests and
 * for `scripts/sign-init-data.ts` (local development outside Telegram).
 */
export function signInitData(
  fields: Record<string, string>,
  botToken: string,
): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const hash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
