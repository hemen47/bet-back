import { Test } from '@nestjs/testing';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { NestNodeApplication, NodeAdapter } from '@nestjs/platform-node';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { signInitData } from '../src/auth/telegram-init-data.js';

const BOT_TOKEN = '123456:E2E-test-token';

describe('Bet API (e2e)', () => {
  let replSet: MongoMemoryReplSet;
  let app: NestNodeApplication;
  let connection: Connection;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      MONGODB_URI: replSet.getUri('bet-e2e'),
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_MODE: 'off',
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
      STARTING_BALANCE: '1000',
      DAILY_REWARD_AMOUNT: '100',
    });
    // Imported after env is set: ConfigModule validates on import.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestNodeApplication>(
      new NodeAdapter(),
    );
    app.useGlobalPipes(new StandardSchemaValidationPipe());
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
    await connection.syncIndexes();
    http = request(app.getHttpServer());
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await replSet?.stop();
  });

  let nextTelegramId = 1000;
  async function signIn(telegramId = nextTelegramId++) {
    const initData = signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({
          id: telegramId,
          first_name: 'Test',
          username: `u${telegramId}`,
        }),
      },
      BOT_TOKEN,
    );
    const res = await http
      .post('/auth/telegram')
      .send({ initData })
      .expect(200);
    return res.body as {
      accessToken: string;
      balance: number;
      user: { id: string };
    };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function bombsOf(gameId: string): Promise<number[]> {
    const doc = await connection
      .collection('mines_games')
      .findOne({ _id: new Types.ObjectId(gameId) });
    return doc!.bombs as number[];
  }

  async function safeTiles(gameId: string): Promise<number[]> {
    const bombs = await bombsOf(gameId);
    return Array.from({ length: 9 }, (_, i) => i).filter(
      (t) => !bombs.includes(t),
    );
  }

  describe('auth', () => {
    it('creates the user and a 1000 coin wallet on first sign-in, once', async () => {
      const first = await signIn(1);
      expect(first.balance).toBe(1000);
      const again = await signIn(1);
      expect(again.user.id).toBe(first.user.id);
      expect(again.balance).toBe(1000);
    });

    it('rejects forged initData', async () => {
      const initData = signInitData(
        {
          auth_date: String(Math.floor(Date.now() / 1000)),
          user: '{"id":5,"first_name":"x"}',
        },
        '999:wrong-token',
      );
      await http.post('/auth/telegram').send({ initData }).expect(401);
    });

    it('requires a bearer token', async () => {
      await http.get('/wallet').expect(401);
      await http.get('/wallet').set(auth('nope')).expect(401);
    });

    it('does not expose the dev sign-in outside development', async () => {
      await http.post('/auth/dev').send({ telegramId: 42 }).expect(404);
    });
  });

  describe('mines', () => {
    it('plays a winning round: bet, reveal, cash out', async () => {
      const { accessToken } = await signIn();

      const start = await http
        .post('/games/mines')
        .set(auth(accessToken))
        .send({ bet: 10 })
        .expect(201);
      expect(start.body.balance).toBe(990);
      const game = start.body.game;
      expect(game).toMatchObject({
        status: 'active',
        bet: 10,
        multiplier: 1,
        nextMultiplier: 1.22,
        canCashOut: false,
        bombs: null,
      });
      expect(game.fairness.serverSeed).toBeNull();

      // Cash-out before any reveal is refused.
      await http
        .post(`/games/mines/${game.id}/cashout`)
        .set(auth(accessToken))
        .expect(400);

      const [tile] = await safeTiles(game.id);
      const reveal = await http
        .post(`/games/mines/${game.id}/reveal`)
        .set(auth(accessToken))
        .send({ tile })
        .expect(200);
      expect(reveal.body.game).toMatchObject({
        multiplier: 1.22,
        cashoutAmount: 12.2,
        canCashOut: true,
        bombs: null,
      });

      // Same tile twice is refused.
      await http
        .post(`/games/mines/${game.id}/reveal`)
        .set(auth(accessToken))
        .send({ tile })
        .expect(400);

      const cash = await http
        .post(`/games/mines/${game.id}/cashout`)
        .set(auth(accessToken))
        .expect(200);
      expect(cash.body.balance).toBe(1002.2);
      expect(cash.body.game).toMatchObject({ status: 'won', payout: 12.2 });
      expect(cash.body.game.bombs).toHaveLength(2);
      expect(cash.body.game.fairness.serverSeed).toMatch(/^[0-9a-f]{64}$/);

      // Provable fairness: the revealed seed reproduces the board.
      const verify = await http
        .get('/games/mines/verify')
        .query({
          serverSeed: cash.body.game.fairness.serverSeed,
          clientSeed: cash.body.game.fairness.clientSeed,
        })
        .expect(200);
      expect(verify.body.bombs).toEqual(cash.body.game.bombs);
      expect(verify.body.serverSeedHash).toBe(
        cash.body.game.fairness.serverSeedHash,
      );
    });

    it('loses the bet on a bomb and ends the game', async () => {
      const { accessToken } = await signIn();
      const { body } = await http
        .post('/games/mines')
        .set(auth(accessToken))
        .send({ bet: 100 })
        .expect(201);
      const [bomb] = await bombsOf(body.game.id);

      const res = await http
        .post(`/games/mines/${body.game.id}/reveal`)
        .set(auth(accessToken))
        .send({ tile: bomb })
        .expect(200);
      expect(res.body.game).toMatchObject({
        status: 'lost',
        hitTile: bomb,
        payout: 0,
        multiplier: 0,
      });

      await http
        .post(`/games/mines/${body.game.id}/cashout`)
        .set(auth(accessToken))
        .expect(409);
      await http
        .post(`/games/mines/${body.game.id}/reveal`)
        .set(auth(accessToken))
        .send({ tile: 0 })
        .expect(409);
      const wallet = await http
        .get('/wallet')
        .set(auth(accessToken))
        .expect(200);
      expect(wallet.body.balance).toBe(900);
    });

    it('auto cashes out when every safe tile is found (34.20×)', async () => {
      const { accessToken } = await signIn();
      const { body } = await http
        .post('/games/mines')
        .set(auth(accessToken))
        .send({ bet: 10 })
        .expect(201);
      let last;
      for (const tile of await safeTiles(body.game.id)) {
        last = await http
          .post(`/games/mines/${body.game.id}/reveal`)
          .set(auth(accessToken))
          .send({ tile })
          .expect(200);
      }
      expect(last!.body.game).toMatchObject({
        status: 'won',
        multiplier: 34.2,
        payout: 342,
      });
      expect(last!.body.balance).toBe(990 + 342);
    });

    it('rejects bets outside 10/50/100 and other users’ games', async () => {
      const a = await signIn();
      const b = await signIn();
      await http
        .post('/games/mines')
        .set(auth(a.accessToken))
        .send({ bet: 20 })
        .expect(400);
      await http
        .post('/games/mines')
        .set(auth(a.accessToken))
        .send({ bet: -10 })
        .expect(400);
      const { body } = await http
        .post('/games/mines')
        .set(auth(a.accessToken))
        .send({ bet: 10 })
        .expect(201);
      await http
        .get(`/games/mines/${body.game.id}`)
        .set(auth(b.accessToken))
        .expect(404);
      await http
        .post(`/games/mines/${body.game.id}/reveal`)
        .set(auth(b.accessToken))
        .send({ tile: 0 })
        .expect(404);
    });

    it('starts one game and takes one bet when starts race', async () => {
      const { accessToken } = await signIn();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          http.post('/games/mines').set(auth(accessToken)).send({ bet: 100 }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s !== 201).every((s) => s === 409)).toBe(
        true,
      );
      const wallet = await http
        .get('/wallet')
        .set(auth(accessToken))
        .expect(200);
      expect(wallet.body.balance).toBe(900);
    });

    it('pays exactly once when cash-outs race', async () => {
      const { accessToken } = await signIn();
      const { body } = await http
        .post('/games/mines')
        .set(auth(accessToken))
        .send({ bet: 50 })
        .expect(201);
      const [t1, t2] = await safeTiles(body.game.id);
      await http
        .post(`/games/mines/${body.game.id}/reveal`)
        .set(auth(accessToken))
        .send({ tile: t1 })
        .expect(200);
      await http
        .post(`/games/mines/${body.game.id}/reveal`)
        .set(auth(accessToken))
        .send({ tile: t2 })
        .expect(200);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          http
            .post(`/games/mines/${body.game.id}/cashout`)
            .set(auth(accessToken)),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const wallet = await http
        .get('/wallet')
        .set(auth(accessToken))
        .expect(200);
      expect(wallet.body.balance).toBe(950 + 81); // 50 × 1.62
      const payouts = await connection
        .collection('wallet_transactions')
        .countDocuments({ key: `mines:${body.game.id}:payout` });
      expect(payouts).toBe(1);
    });

    it('restores the active game after a refresh, without leaking bombs', async () => {
      const { accessToken } = await signIn();
      expect(
        (await http.get('/games/mines/active').set(auth(accessToken))).body
          .game,
      ).toBeNull();
      const { body } = await http
        .post('/games/mines')
        .set(auth(accessToken))
        .send({ bet: 10 })
        .expect(201);
      const [tile] = await safeTiles(body.game.id);
      await http
        .post(`/games/mines/${body.game.id}/reveal`)
        .set(auth(accessToken))
        .send({ tile })
        .expect(200);

      const active = await http
        .get('/games/mines/active')
        .set(auth(accessToken))
        .expect(200);
      expect(active.body.game).toMatchObject({
        id: body.game.id,
        revealed: [tile],
        multiplier: 1.22,
        bombs: null,
      });
      expect(JSON.stringify(active.body)).not.toContain('serverSeed":"');
    });

    it('commits the server seed before the game starts', async () => {
      const { accessToken } = await signIn();
      const commit = await http
        .get('/games/mines/fairness')
        .set(auth(accessToken))
        .expect(200);
      const { body } = await http
        .post('/games/mines')
        .set(auth(accessToken))
        .send({ bet: 10, clientSeed: 'my-lucky-seed' })
        .expect(201);
      expect(body.game.fairness).toMatchObject({
        serverSeedHash: commit.body.serverSeedHash,
        clientSeed: 'my-lucky-seed',
      });
      const next = await http
        .get('/games/mines/fairness')
        .set(auth(accessToken))
        .expect(200);
      expect(next.body.serverSeedHash).not.toBe(commit.body.serverSeedHash);
    });

    it('lists the 10 most recent finished games', async () => {
      const { accessToken } = await signIn();
      for (let i = 0; i < 12; i++) {
        const { body } = await http
          .post('/games/mines')
          .set(auth(accessToken))
          .send({ bet: 10 })
          .expect(201);
        const [bomb] = await bombsOf(body.game.id);
        await http
          .post(`/games/mines/${body.game.id}/reveal`)
          .set(auth(accessToken))
          .send({ tile: bomb })
          .expect(200);
      }
      const history = await http
        .get('/games/mines/history')
        .set(auth(accessToken))
        .expect(200);
      expect(history.body.items).toHaveLength(10);
      expect(history.body.items[0]).toMatchObject({
        bet: 10,
        multiplier: 0,
        payout: 0,
        profit: -10,
        result: 'lost',
      });
    });
  });

  describe('crash', () => {
    /** Test-only time travel: fix the crash point and move lift-off into the past. */
    async function rig(gameId: string, crashX100: number, elapsedMs: number) {
      await connection.collection('crash_games').updateOne(
        { _id: new Types.ObjectId(gameId) },
        {
          $set: {
            crashPointX100: crashX100,
            startsAt: new Date(Date.now() - elapsedMs),
          },
        },
      );
    }

    async function startRound(token: string, body: object = { bet: 10 }) {
      const res = await http
        .post('/games/crash')
        .set(auth(token))
        .send(body)
        .expect(201);
      return res.body as { game: { id: string }; balance: number };
    }

    it('takes the bet, hides the crash point, refuses an early cash-out', async () => {
      const { accessToken } = await signIn();
      const { game, balance } = await startRound(accessToken);
      expect(balance).toBe(990);
      expect(game).toMatchObject({
        status: 'running',
        bet: 10,
        crashPoint: null,
        cashoutMultiplier: null,
        profit: null,
      });
      expect((game as { fairness: { serverSeed: unknown } }).fairness.serverSeed).toBeNull();
      expect(JSON.stringify(game)).not.toMatch(/crashPointX100|bombs/);

      // Still in the waiting phase.
      const early = await http
        .post(`/games/crash/${game.id}/cashout`)
        .set(auth(accessToken))
        .expect(400);
      expect(early.body.error).toBe('not_started');

      // One running round per user.
      await http
        .post('/games/crash')
        .set(auth(accessToken))
        .send({ bet: 10 })
        .expect(409);
    });

    it('cashes out at the server-side multiplier and pays bet × multiplier', async () => {
      const { accessToken } = await signIn();
      const { game } = await startRound(accessToken, { bet: 100 });
      const { msToReach } = await import('../src/games/crash/crash.math.js');
      await rig(game.id, 1000, msToReach(250)); // now at 2.50×, crashes at 10×

      const res = await http
        .post(`/games/crash/${game.id}/cashout`)
        .set(auth(accessToken))
        .expect(200);
      const g = res.body.game;
      expect(g.status).toBe('cashed_out');
      expect(g.cashoutMultiplier).toBeGreaterThanOrEqual(2.5);
      expect(g.cashoutMultiplier).toBeLessThan(2.6);
      expect(g.payout).toBeCloseTo(100 * g.cashoutMultiplier, 2);
      expect(g.profit).toBeCloseTo(g.payout - 100, 2);
      expect(res.body.balance).toBeCloseTo(900 + g.payout, 2);
      // Revealed once over, and verifiable.
      expect(g.crashPoint).toBe(10);
      const verify = await http
        .get('/games/crash/verify')
        .query({ serverSeed: g.fairness.serverSeed, clientSeed: g.fairness.clientSeed })
        .expect(200);
      expect(verify.body.serverSeedHash).toBe(g.fairness.serverSeedHash);
    });

    it('pays exactly once when many cash-outs race', async () => {
      const { accessToken, user } = await signIn();
      const { game } = await startRound(accessToken);
      const { msToReach } = await import('../src/games/crash/crash.math.js');
      await rig(game.id, 5000, msToReach(150));

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          http.post(`/games/crash/${game.id}/cashout`).set(auth(accessToken)),
        ),
      );
      expect(results.some((r) => r.status === 200)).toBe(true);
      const payouts = await connection
        .collection('wallet_transactions')
        .countDocuments({ key: `crash:${game.id}:payout` });
      expect(payouts).toBe(1);

      const wallet = await http.get('/wallet').set(auth(accessToken)).expect(200);
      const ended = await http.get(`/games/crash/${game.id}`).set(auth(accessToken));
      expect(wallet.body.balance).toBeCloseTo(990 + ended.body.game.payout, 2);
      expect(user.id).toBeTruthy();
    });

    it('loses the bet when the cash-out arrives after the crash', async () => {
      const { accessToken } = await signIn();
      const { game } = await startRound(accessToken, { bet: 50 });
      const { msToReach } = await import('../src/games/crash/crash.math.js');
      await rig(game.id, 180, msToReach(200)); // crashed at 1.80× already

      const res = await http
        .post(`/games/crash/${game.id}/cashout`)
        .set(auth(accessToken))
        .expect(200);
      expect(res.body.balance).toBeNull();
      expect(res.body.game).toMatchObject({
        status: 'crashed',
        crashPoint: 1.8,
        payout: 0,
        profit: -50,
        cashoutMultiplier: null,
      });
      const wallet = await http.get('/wallet').set(auth(accessToken)).expect(200);
      expect(wallet.body.balance).toBe(950);

      // A second try is refused, and the round is in the history.
      await http.post(`/games/crash/${game.id}/cashout`).set(auth(accessToken)).expect(409);
      const history = await http.get('/games/crash/history').set(auth(accessToken)).expect(200);
      expect(history.body.items[0]).toMatchObject({
        bet: 50,
        crashPoint: 1.8,
        cashoutMultiplier: null,
        profit: -50,
        result: 'lost',
      });
    });

    it('auto cash-out pays exactly the target, reported by the long-poll', async () => {
      const { accessToken } = await signIn();
      const { game } = await startRound(accessToken, { bet: 10, autoCashout: 2 });
      const { msToReach } = await import('../src/games/crash/crash.math.js');
      await rig(game.id, 300, msToReach(200) - 150); // reaches 2.00× in 150 ms, crashes at 3×

      const res = await http
        .get(`/games/crash/${game.id}/wait`)
        .set(auth(accessToken))
        .expect(200);
      expect(res.body.game).toMatchObject({
        status: 'cashed_out',
        cashoutMultiplier: 2,
        payout: 20,
        profit: 10,
        crashPoint: 3,
      });
      expect(res.body.balance).toBe(1010);
    });

    it('long-poll reports the crash, and active is empty afterwards', async () => {
      const { accessToken } = await signIn();
      const { game } = await startRound(accessToken);
      const { msToReach } = await import('../src/games/crash/crash.math.js');
      await rig(game.id, 120, msToReach(120) - 100);

      const active = await http.get('/games/crash/active').set(auth(accessToken)).expect(200);
      expect(active.body.game.id).toBe(game.id);

      const res = await http.get(`/games/crash/${game.id}/wait`).set(auth(accessToken)).expect(200);
      expect(res.body.game).toMatchObject({ status: 'crashed', crashPoint: 1.2 });
      expect(res.body.balance).toBe(990);
      const after = await http.get('/games/crash/active').set(auth(accessToken)).expect(200);
      expect(after.body.game).toBeNull();
    });

    it('rejects bets outside 10/50/100 and bad auto cash-out values', async () => {
      const { accessToken } = await signIn();
      await http.post('/games/crash').set(auth(accessToken)).send({ bet: 20 }).expect(400);
      await http
        .post('/games/crash')
        .set(auth(accessToken))
        .send({ bet: 10, autoCashout: 1 })
        .expect(400);
    });
  });

  describe('roulette', () => {
    const SEED = 'b'.repeat(64);

    /** Commits a known server seed for the user's next spin (test-only). */
    async function commitSeed(userId: string) {
      const { hashServerSeed } = await import('../src/games/shared/fairness.js');
      await connection.collection('roulette_seeds').updateOne(
        { userId: new Types.ObjectId(userId) },
        { $set: { serverSeed: SEED, serverSeedHash: hashServerSeed(SEED) } },
        { upsert: true },
      );
    }

    /** A client seed that makes SEED land on a number matching `want`. */
    async function clientSeedFor(want: (n: number) => boolean) {
      const { spinNumber } = await import('../src/games/roulette/roulette.math.js');
      for (let i = 0; ; i++) if (want(spinNumber(SEED, `c${i}`))) return `c${i}`;
    }

    const spin = (token: string, body: object) =>
      http.post('/games/roulette/spin').set(auth(token)).send(body);

    it('task example: 1000, bet 100 on red, red wins, pays 200, ends at 1100', async () => {
      const { accessToken, user } = await signIn();
      const { colorOf } = await import('../src/games/roulette/roulette.math.js');
      await commitSeed(user.id);
      const clientSeed = await clientSeedFor((n) => colorOf(n) === 'red');

      const res = await spin(accessToken, {
        requestId: 'req-red-win-1',
        bets: [{ target: 'red', amount: 100 }],
        clientSeed,
      }).expect(200);
      expect(res.body.round.color).toBe('red');
      expect(res.body.round).toMatchObject({ totalBet: 100, payout: 200, profit: 100 });
      expect(res.body.round.bets[0]).toMatchObject({ target: 'red', multiplier: 2, won: true });
      expect(res.body.balanceAfterBet).toBe(900);
      expect(res.body.balance).toBe(1100);
      // The seed is revealed and the result is verifiable.
      const v = await http
        .get('/games/roulette/verify')
        .query({ serverSeed: SEED, clientSeed })
        .expect(200);
      expect(v.body.number).toBe(res.body.round.number);
    });

    it('settles several bets at once; 0 loses red/even and pays straight ×36', async () => {
      const { accessToken, user } = await signIn();
      await commitSeed(user.id);
      const clientSeed = await clientSeedFor((n) => n === 0);

      const res = await spin(accessToken, {
        requestId: 'req-zero-1',
        bets: [
          { target: 'red', amount: 50 },
          { target: 'even', amount: 10 },
          { target: 'straight:0', amount: 10 },
          { target: 'straight:0', amount: 10 }, // merged with the chip above
        ],
        clientSeed,
      }).expect(200);
      expect(res.body.round.number).toBe(0);
      expect(res.body.round.totalBet).toBe(80);
      expect(res.body.round.payout).toBe(720); // 20 × 36
      expect(res.body.balance).toBe(1000 - 80 + 720);
      const straight = res.body.round.bets.find((b: { target: string }) => b.target === 'straight:0');
      expect(straight).toMatchObject({ amount: 20, payout: 720, won: true });
    });

    it('a duplicate submission replays the first result and charges once', async () => {
      const { accessToken } = await signIn();
      const body = { requestId: 'req-dup-123', bets: [{ target: 'black', amount: 50 }] };
      const results = await Promise.all(Array.from({ length: 5 }, () => spin(accessToken, body)));
      results.forEach((r) => expect(r.status).toBe(200));
      const ids = new Set(results.map((r) => r.body.round.id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);

      const id = results[0].body.round.id;
      const bets = await connection
        .collection('wallet_transactions')
        .countDocuments({ key: `roulette:${id}:bet` });
      expect(bets).toBe(1);
      const wallet = await http.get('/wallet').set(auth(accessToken)).expect(200);
      expect(wallet.body.balance).toBe(results[0].body.balance);
    });

    it('never spends the same balance twice under concurrent spins', async () => {
      const { accessToken, user } = await signIn();
      // Leave 150 coins: at most one 100-coin spin can be paid for (if the first loses).
      await connection
        .collection('wallets')
        .updateOne({ userId: new Types.ObjectId(user.id) }, { $set: { balance: 15_000 } });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          spin(accessToken, { requestId: `req-race-${i}-xyz`, bets: [{ target: 'straight:7', amount: 100 }] }),
        ),
      );
      const ok = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 400);
      expect(ok.length + refused.length).toBe(6);
      refused.forEach((r) => expect(r.body.error).toBe('insufficient_balance'));
      const wallet = await http.get('/wallet').set(auth(accessToken)).expect(200);
      expect(wallet.body.balance).toBeGreaterThanOrEqual(0);
      // Ledger and wallet agree.
      const sum = await connection
        .collection('wallet_transactions')
        .aggregate([
          { $match: { userId: new Types.ObjectId(user.id), game: 'roulette' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
        .toArray();
      expect(15_000 + (sum[0]?.total ?? 0)).toBe(Math.round(wallet.body.balance * 100));
    });

    it('rejects bad bets and over-balance stakes without charging', async () => {
      const { accessToken } = await signIn();
      await spin(accessToken, { requestId: 'req-bad-1', bets: [{ target: 'straight:37', amount: 10 }] }).expect(400);
      await spin(accessToken, { requestId: 'req-bad-2', bets: [{ target: 'red', amount: 15 }] }).expect(400);
      await spin(accessToken, { requestId: 'req-bad-3', bets: [] }).expect(400);
      const tooMuch = await spin(accessToken, {
        requestId: 'req-bad-4',
        bets: [{ target: 'red', amount: 600 }, { target: 'black', amount: 600 }],
      }).expect(400);
      expect(tooMuch.body.error).toBe('invalid_bet');
      const wallet = await http.get('/wallet').set(auth(accessToken)).expect(200);
      expect(wallet.body.balance).toBe(1000);
    });

    it('keeps the last 10 spins in the history', async () => {
      const { accessToken } = await signIn();
      for (let i = 0; i < 11; i++) {
        await spin(accessToken, { requestId: `req-hist-${i}-abc`, bets: [{ target: 'odd', amount: 10 }] }).expect(200);
      }
      const res = await http.get('/games/roulette/history').set(auth(accessToken)).expect(200);
      expect(res.body.items).toHaveLength(10);
      expect(res.body.items[0]).toMatchObject({ totalBet: 10, bets: [{ target: 'odd', amount: 10 }] });
      expect(['red', 'black', 'green']).toContain(res.body.items[0].color);
    });
  });

  describe('poop + missions', () => {
    async function answersOf(gameId: string): Promise<string[]> {
      const doc = await connection.collection('poop_games').findOne({ _id: new Types.ObjectId(gameId) });
      return doc!.answers as string[];
    }
    const flip = (c: string) => (c === 'poop' ? 'laugh' : 'poop');
    const start = async (token: string, bet = 100) =>
      (await http.post('/games/poop').set(auth(token)).send({ bet }).expect(201)).body as {
        game: { id: string };
        balance: number;
      };
    const pick = (token: string, id: string, stage: number, choice: string) =>
      http.post(`/games/poop/${id}/pick`).set(auth(token)).send({ stage, choice });

    /** Mission progress is reported in the background: poll briefly. */
    async function missionsOf(token: string, until: (items: { id: string; progress: number }[]) => boolean) {
      for (let i = 0; i < 40; i++) {
        const res = await http.get('/missions').set(auth(token)).expect(200);
        if (until(res.body.items)) return res.body.items as { id: string; progress: number; completed: boolean; claimed: boolean }[];
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('missions did not update');
    }

    it('task example: bet 100, two correct picks, cash out 380, ends at 1280', async () => {
      const { accessToken } = await signIn();
      const { game, balance } = await start(accessToken);
      expect(balance).toBe(900);
      expect(game).toMatchObject({ status: 'active', completed: 0, multiplier: 1, nextMultiplier: 1.9, canCashOut: false, answers: null });

      await http.post(`/games/poop/${game.id}/cashout`).set(auth(accessToken)).expect(400);

      const answers = await answersOf(game.id);
      const s1 = await pick(accessToken, game.id, 1, answers[0]).expect(200);
      expect(s1.body.game).toMatchObject({ completed: 1, multiplier: 1.9, nextMultiplier: 3.8, cashoutAmount: 190, answers: null });
      const s2 = await pick(accessToken, game.id, 2, answers[1]).expect(200);
      expect(s2.body.game).toMatchObject({ completed: 2, multiplier: 3.8, cashoutAmount: 380 });

      const cash = await http.post(`/games/poop/${game.id}/cashout`).set(auth(accessToken)).expect(200);
      expect(cash.body.balance).toBe(1280);
      expect(cash.body.game).toMatchObject({ status: 'won', payout: 380, profit: 280 });
      expect(cash.body.game.answers).toEqual(answers);

      // A second cash-out is refused and pays nothing.
      await http.post(`/games/poop/${game.id}/cashout`).set(auth(accessToken)).expect(409);
      const payouts = await connection.collection('wallet_transactions').countDocuments({ key: `poop:${game.id}:payout` });
      expect(payouts).toBe(1);

      // Missions: 2 in a row is done and claimable once; 7.60× is not.
      const items = await missionsOf(accessToken, (m) => m.find((x) => x.id === 'poop_play_5')!.progress === 1);
      expect(items.find((m) => m.id === 'poop_streak_2')).toMatchObject({ progress: 2, completed: true, claimed: false });
      const claim = await http.post('/missions/poop_streak_2/claim').set(auth(accessToken)).expect(200);
      expect(claim.body).toEqual({ reward: 30, balance: 1310 });
      await http.post('/missions/poop_streak_2/claim').set(auth(accessToken)).expect(409);
      const incomplete = await http.post('/missions/poop_reach_760/claim').set(auth(accessToken)).expect(400);
      expect(incomplete.body.error).toBe('mission_incomplete');
    });

    it('a wrong pick ends the round and loses the bet; history records it', async () => {
      const { accessToken } = await signIn();
      const { game } = await start(accessToken);
      const answers = await answersOf(game.id);
      await pick(accessToken, game.id, 1, answers[0]).expect(200);
      const lost = await pick(accessToken, game.id, 2, flip(answers[1])).expect(200);
      expect(lost.body.game).toMatchObject({ status: 'lost', completed: 1, payout: 0, profit: -100, canCashOut: false });
      expect(lost.body.game.picks[1]).toEqual({ choice: flip(answers[1]), correct: false });
      expect(lost.body.game.fairness.serverSeed).toMatch(/^[0-9a-f]{64}$/);

      const wallet = await http.get('/wallet').set(auth(accessToken)).expect(200);
      expect(wallet.body.balance).toBe(900);
      const history = await http.get('/games/poop/history').set(auth(accessToken)).expect(200);
      expect(history.body.items[0]).toMatchObject({ bet: 100, completed: 1, multiplier: null, profit: -100, result: 'lost' });
    });

    it('a repeated pick replays instead of applying twice; a stale stage is refused', async () => {
      const { accessToken } = await signIn();
      const { game } = await start(accessToken, 10);
      const answers = await answersOf(game.id);
      const results = await Promise.all(Array.from({ length: 4 }, () => pick(accessToken, game.id, 1, answers[0])));
      results.forEach((r) => expect(r.status).toBe(200));
      const doc = await connection.collection('poop_games').findOne({ _id: new Types.ObjectId(game.id) });
      expect(doc!.step).toBe(1);
      expect(doc!.picks).toHaveLength(1);

      // Same stage, other choice: refused. Skipping ahead: refused.
      await pick(accessToken, game.id, 1, flip(answers[0])).expect(409);
      await pick(accessToken, game.id, 3, answers[2]).expect(409);
    });

    it('clearing all 5 stages pays 30.40× automatically, once', async () => {
      const { accessToken } = await signIn();
      const { game } = await start(accessToken, 10);
      const answers = await answersOf(game.id);
      let last;
      for (let s = 1; s <= 5; s++) last = await pick(accessToken, game.id, s, answers[s - 1]).expect(200);
      expect(last!.body.game).toMatchObject({ status: 'won', completed: 5, multiplier: 30.4, payout: 304 });
      expect(last!.body.balance).toBe(990 + 304);
      await http.post(`/games/poop/${game.id}/cashout`).set(auth(accessToken)).expect(409);
      const items = await missionsOf(accessToken, (m) => m.find((x) => x.id === 'poop_reach_760')!.progress === 3);
      expect(items.find((m) => m.id === 'poop_reach_760')).toMatchObject({ completed: true });
    });

    it('allows one active round per user and rejects other bet sizes', async () => {
      const { accessToken } = await signIn();
      await start(accessToken, 10);
      const second = await http.post('/games/poop').set(auth(accessToken)).send({ bet: 10 }).expect(409);
      expect(second.body.error).toBe('active_game_exists');
      const active = await http.get('/games/poop/active').set(auth(accessToken)).expect(200);
      expect(active.body.game.status).toBe('active');
      await http.post('/games/poop').set(auth(accessToken)).send({ bet: 25 }).expect(400);
    });
  });

  describe('daily reward', () => {
    it('can be claimed once per day', async () => {
      const { accessToken } = await signIn();
      expect(
        (await http.get('/rewards/daily').set(auth(accessToken))).body
          .available,
      ).toBe(true);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          http.post('/rewards/daily/claim').set(auth(accessToken)),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      const wallet = await http
        .get('/wallet')
        .set(auth(accessToken))
        .expect(200);
      expect(wallet.body.balance).toBe(1100);
      expect(
        (await http.get('/rewards/daily').set(auth(accessToken))).body
          .available,
      ).toBe(false);
    });
  });
});
