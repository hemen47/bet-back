import {
  InitDataError,
  signInitData,
  validateInitData,
} from './telegram-init-data.js';

const TOKEN = '123456:TEST-token';
const now = new Date('2026-11-11T12:00:00Z');
const authDate = String(Math.floor(now.getTime() / 1000) - 60);
const user = JSON.stringify({ id: 42, first_name: 'Ada', username: 'ada' });

describe('validateInitData', () => {
  it('accepts data signed with the bot token', () => {
    const initData = signInitData(
      { auth_date: authDate, user, query_id: 'q1' },
      TOKEN,
    );
    const result = validateInitData(initData, TOKEN, 3600, now);
    expect(result.user).toMatchObject({ id: 42, first_name: 'Ada' });
    expect(result.queryId).toBe('q1');
  });

  it('rejects another bot token', () => {
    const initData = signInitData({ auth_date: authDate, user }, 'other:token');
    expect(() => validateInitData(initData, TOKEN, 3600, now)).toThrow(
      InitDataError,
    );
  });

  it('rejects tampered fields', () => {
    const initData = signInitData({ auth_date: authDate, user }, TOKEN).replace(
      encodeURIComponent('"id":42'),
      encodeURIComponent('"id":43'),
    );
    expect(() => validateInitData(initData, TOKEN, 3600, now)).toThrow(
      /signature/,
    );
  });

  it('rejects expired data', () => {
    const old = String(Math.floor(now.getTime() / 1000) - 7200);
    const initData = signInitData({ auth_date: old, user }, TOKEN);
    expect(() => validateInitData(initData, TOKEN, 3600, now)).toThrow(
      /expired/,
    );
  });

  it('rejects data without hash', () => {
    expect(() =>
      validateInitData(`auth_date=${authDate}`, TOKEN, 3600, now),
    ).toThrow(InitDataError);
  });
});
