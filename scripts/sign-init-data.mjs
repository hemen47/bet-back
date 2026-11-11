/**
 * Prints a valid Telegram initData string signed with TELEGRAM_BOT_TOKEN,
 * so the API can be called from Postman/curl or a browser outside Telegram.
 *
 *   pnpm init-data [telegramId] [firstName]
 *
 * Then: POST /auth/telegram { "initData": "<output>" }
 * Same algorithm as signInitData() in src/auth/telegram-init-data.ts.
 */
import { createHmac } from 'node:crypto';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const id = Number(process.argv[2] ?? 100000001);
const firstName = process.argv[3] ?? 'Dev';
const fields = {
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'dev',
  user: JSON.stringify({ id, first_name: firstName, username: `dev${id}` }),
};

const dataCheckString = Object.keys(fields)
  .sort()
  .map((key) => `${key}=${fields[key]}`)
  .join('\n');
const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

console.log(new URLSearchParams({ ...fields, hash }).toString());
