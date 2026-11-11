# Bet: Telegram Mini App backend

NestJS 12 (ESM) + MongoDB backend for a Telegram Mini App with multiple casino-style games, each one its own module. Coins are virtual: no deposits or withdrawals.

Games:
- **Crash**: the multiplier climbs from 1.00× until a provably fair crash point. Cash out in time to win bet × multiplier. Includes auto cash-out.
- **Mines**: 3×3 grid, 2 bombs.
- **European Roulette**: numbers 0–36, several chips per spin. Straight ×36; red/black, even/odd, 1–18/19–36 ×2; dozens and columns ×3.
- **Poop**: 5 stages of 💩 / 😆 (50/50 each). Pick right to climb 1.90× → 3.80× → 7.60× → 15.20× → 30.40×, and cash out after any correct pick.

Crash, Mines and Poop have a 5% house edge; roulette has the standard 2.70% (1/37). Bonuses: daily reward, **daily missions**, provably fair verification on every game, Crash auto cash-out, and simulated Crash players. Bonuses: daily login reward, provably fair verification, auto cash-out, and simulated players on Crash (labelled as simulated).

## Stack

| Concern | Choice |
| --- | --- |
| HTTP | `@nestjs/platform-node` (`NodeAdapter`) |
| DB | MongoDB via `@nestjs/mongoose`, **replica set required** (transactions) |
| Auth | Telegram `initData` HMAC check → short-lived JWT (`@nestjs/authentication`) |
| Validation | Zod + `StandardSchemaValidationPipe` |
| Rate limiting | `@nestjs/throttler` |
| Bot | grammY, webhook (prod) or long polling (dev) |
| Deploy | Docker Compose (api + web, Next proxies `/api`) behind host nginx + Cloudflare |
| Tests | Vitest; e2e on an in-memory Mongo replica set |

## Layout

```
src/
  config/          env schema (Zod), validated at startup
  auth/            initData validation, POST /auth/telegram, JWT provider
  users/           Telegram users
  wallet/          one wallet per user + append-only ledger (shared by all games)
  rewards/         daily reward
  missions/        daily missions: definitions, progress reported by games, one-time claims
  games/
    shared/        commit/reveal seed helpers used by every game
    mines/         Mines: math, provably-fair RNG, service, controller
    crash/         Crash: curve + crash-point math, service, long-poll, controller
    roulette/      Roulette: table math, unbiased number draw, idempotent spin, controller
    poop/          Poop: 5-stage 50/50 tower, idempotent picks, cash-out, mission events
  telegram/        bot (/start → "Play" button, menu button) + webhook
  health/          GET /health
```

To add a game, create `src/games/<name>/` with its own module. Move money only through `WalletService.debit/credit` inside a transaction, with a unique ledger key such as `<game>:<gameId>:bet` or `<game>:<gameId>:payout`.

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill MONGODB_URI, TELEGRAM_BOT_TOKEN, JWT_SECRET
pnpm start:dev            # API on http://localhost:47311
```

Then run `bet-front` with `pnpm dev` and open http://localhost:47310. Next proxies `/api/*` to the API.

`mongodb+srv://` URIs work even where the local DNS server refuses SRV lookups: `src/common/dns.ts` points Node's resolver at public DNS (set `DNS_SERVERS=system` in the environment to turn this off).

Local development outside Telegram: generate a valid signed `initData` for a fake user:

```bash
pnpm init-data 100000001 Alice
# → paste into POST /auth/telegram { "initData": "..." }
```

### Tests

```bash
pnpm test        # unit: multipliers, RNG fairness, initData validation
pnpm test:e2e    # full API against an in-memory Mongo replica set
```

`test:e2e` downloads a MongoDB binary (~800 MB) on its first run. To use a local install instead, set `MONGOMS_SYSTEM_BINARY` (for example `C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe`) and `MONGOMS_VERSION=8.2.0`.

## API

All routes except those marked 🌐 need `Authorization: Bearer <accessToken>`. Amounts are coins (up to 2 decimals).

### Auth
| | Route | Body / result |
|---|---|---|
| 🌐 | `POST /auth/telegram` | `{ initData }` → `{ accessToken, expiresIn, user, balance, startParam? }`. The first call creates the user with 1,000 coins. |
| | `GET /auth/me` | `{ user, balance }` |

On a 401, sign in again with the current `Telegram.WebApp.initData`.

### Wallet
| Route | Result |
|---|---|
| `GET /wallet` | `{ balance }` |
| `GET /wallet/transactions?limit=20&before=<id>` | `{ items: [{ id, type, amount, balanceAfter, game, gameId, createdAt }] }` |

### Daily reward
| Route | Result |
|---|---|
| `GET /rewards/daily` | `{ amount, available, nextClaimAt }` |
| `POST /rewards/daily/claim` | `{ amount, balance, nextClaimAt }`, or 409 `already_claimed` (resets at 00:00 UTC) |

### Mines
| | Route | Body / result |
|---|---|---|
| 🌐 | `GET /games/mines/config` | grid, `betOptions: [10,50,100]`, `houseEdge`, multiplier table |
| | `GET /games/mines/fairness` | `{ serverSeedHash }`: commitment for your next game |
| | `POST /games/mines` | `{ bet: 10\|50\|100, clientSeed? }` → `{ game, balance }`. 409 `active_game_exists`, 400 `insufficient_balance` |
| | `GET /games/mines/active` | `{ game \| null }`. **Call on app load** to resume after a refresh or disconnect |
| | `POST /games/mines/:id/reveal` | `{ tile: 0..8 }` → `{ game, balance }`. `balance` is set only when the reveal ended the game with a win |
| | `POST /games/mines/:id/cashout` | → `{ game, balance }`. 400 `nothing_to_cash_out`, 409 `game_over` |
| | `GET /games/mines/history` | last 10 finished games: `{ items: [{ bet, multiplier, payout, profit, result }] }` |
| | `GET /games/mines/:id` | one game |
| 🌐 | `GET /games/mines/verify?serverSeed=&clientSeed=` | recomputes bombs: `{ serverSeedHash, bombs }` |

`game` shape:

```jsonc
{
  "id": "…", "status": "active" | "won" | "lost",
  "bet": 10, "tiles": 9, "mines": 2,
  "revealed": [4, 0],            // tile indices, row-major 0..8
  "multiplier": 1.62,            // current (final once ended, 0 on loss)
  "nextMultiplier": 2.28,        // null when the game is over
  "cashoutAmount": 16.2,         // what cash-out pays right now
  "canCashOut": true,
  "payout": 0, "hitTile": null,
  "bombs": null,                 // revealed only once the game is over
  "fairness": { "serverSeedHash": "…", "clientSeed": "…", "serverSeed": null },
  "createdAt": "…", "endedAt": null
}
```

Uncovering the last safe tile cashes out automatically (34.20×).

### Crash
| | Route | Body / result |
|---|---|---|
| 🌐 | `GET /games/crash/config` | `betOptions`, `houseEdge`, `growthPerMs`, `startDelayMs`, auto cash-out limits |
| | `GET /games/crash/fairness` | `{ serverSeedHash }` for your next round |
| | `POST /games/crash` | `{ bet: 10\|50\|100, autoCashout?: 1.01..1000, clientSeed? }` → `{ game, balance }`. 409 `active_game_exists` |
| | `GET /games/crash/active` | `{ game \| null }`. Call on load to resume |
| | `GET /games/crash/:id/wait` | Long-poll. Answers at the crash or auto cash-out (or after 20 s): `{ game, balance \| null }` |
| | `POST /games/crash/:id/cashout` | Cashes out at the server's multiplier *now* → `{ game, balance }`. 400 `not_started`, 409 `game_over`. If it arrives after the crash: `status: "crashed"`, `balance: null` |
| | `GET /games/crash/history` | last 10: `{ items: [{ bet, crashPoint, cashoutMultiplier, profit, result, endedAt }] }` |
| | `GET /games/crash/:id` | one round |
| 🌐 | `GET /games/crash/verify?serverSeed=&clientSeed=` | `{ serverSeedHash, crashPoint }` |

`game`: `{ id, status: "running"|"cashed_out"|"crashed", bet, autoCashout, startsAt, serverNow, cashoutMultiplier, payout, profit, crashPoint, fairness }`. `crashPoint` and `fairness.serverSeed` stay `null` until the round is over.

### Roulette
| | Route | Body / result |
|---|---|---|
| 🌐 | `GET /games/roulette/config` | `chips: [10,50,100]`, `maxTotalBet`, `wheelOrder`, `redNumbers`, payout table |
| | `GET /games/roulette/fairness` | `{ serverSeedHash }` for your next spin |
| | `POST /games/roulette/spin` | `{ requestId, bets: [{ target, amount }], clientSeed? }` → `{ round, balanceAfterBet, balance, replayed }`. 400 `insufficient_balance` / `invalid_bet` |
| | `GET /games/roulette/history` | last 10 rounds |
| | `GET /games/roulette/:id` | one round |
| 🌐 | `GET /games/roulette/verify?serverSeed=&clientSeed=` | `{ serverSeedHash, number, color }` |

Targets: `straight:0`…`straight:36`, `red`, `black`, `even`, `odd`, `low`, `high`, `dozen:1..3`, `column:1..3`. Amounts are multiples of 10 (chips of 10/50/100). Chips on the same target are merged. The limit is 1,000 coins per spin.

`round`: `{ id, number, color, bets: [{ target, amount, multiplier, payout, won }], totalBet, payout, profit, fairness, createdAt }`.

### Poop
| | Route | Body / result |
|---|---|---|
| 🌐 | `GET /games/poop/config` | `stages: 5`, `betOptions`, `houseEdge`, multiplier table |
| | `GET /games/poop/fairness` | `{ serverSeedHash }` for your next round |
| | `POST /games/poop` | `{ bet: 10\|50\|100, clientSeed? }` → `{ game, balance }`. 409 `active_game_exists` |
| | `GET /games/poop/active` | `{ game \| null }`. Call on load to resume |
| | `POST /games/poop/:id/pick` | `{ stage: 1..5, choice: "poop"\|"laugh" }` → `{ game, balance, replayed }`. `balance` is set when stage 5 pays out automatically |
| | `POST /games/poop/:id/cashout` | → `{ game, balance }`. 400 `nothing_to_cash_out`, 409 `game_over` |
| | `GET /games/poop/history` | last 10: `{ items: [{ bet, completed, multiplier, profit, result, endedAt }] }` |
| 🌐 | `GET /games/poop/verify?serverSeed=&clientSeed=` | `{ serverSeedHash, answers }` |

`game`: `{ id, status: "active"|"won"|"lost", bet, completed, picks: [{ choice, correct }], multiplier, nextMultiplier, cashoutAmount, canCashOut, payout, profit, answers, fairness }`. `answers` and `fairness.serverSeed` stay `null` until the round is over.

### Missions
| Route | Result |
|---|---|
| `GET /missions` | `{ items: [{ id, game, description, target, progress, reward, completed, claimed }], resetsAt }`. Resets at 00:00 UTC |
| `POST /missions/:id/claim` | `{ reward, balance }`. 400 `mission_incomplete`, 409 `already_claimed` |

Today's missions: play 5 rounds of Poop (+50), make 2 correct choices in a row (+30), reach 7.60× (+100).

## Poop mechanics

- **Answers fixed at the start.** Stage `k` is the low bit of `HMAC_SHA256(serverSeed, clientSeed:k)`: an independent fair coin per stage. All 5 are stored (secret) when the bet is taken and revealed when the round ends.
- **Payouts.** The task's table, 0.95 × 2^k: 1.90×, 3.80×, 7.60×, 15.20×, 30.40×. Cash-out pays `bet × current multiplier`. Clearing stage 5 pays automatically. Example: bet 100, two correct picks, cash out at 3.80× → 380, final balance 1,280 (covered by a test).
- **Duplicate requests.** A pick names its `stage`. Repeating an already answered stage with the same choice (a double tap, or a retry after a lost response) returns the current state with `replayed: true`. A different choice, or skipping ahead, gets 409. Writes are conditional on the step, so a pick can never apply twice, even when copies race.
- **Missions** are reported after each successful move. They are best effort and never block a game action. A claim is a conditional update plus a ledger entry with the unique key `mission:<user>:<day>:<id>`, in one transaction, so it pays once.

## Roulette mechanics

- **One request, one transaction.** `POST /spin` consumes the committed seed, draws the number, debits the total stake, and credits the payout, all at once. The result exists before the wheel starts spinning, so a refresh or disconnect can't change or lose it. The client animates the wheel to `round.number`, showing `balanceAfterBet` while it spins and `balance` once the ball stops.
- **Number draw.** 4-byte chunks of `HMAC_SHA256(serverSeed, clientSeed:round)` are rejection-sampled into 0–36, so every pocket is exactly 1/37 with no modulo bias. The server seed is revealed with the result.
- **Payouts.** A bet covering `k` numbers pays `36 / k` (stake included), so every bet returns 36/37 on average. 0 loses all outside bets. Example: 1,000 → 100 on Red → Red → payout 200 → 1,100 (covered by a test).
- **Duplicate submissions.** The client sends a fresh `requestId` per Spin press and resends the same one if a response is lost. The `(userId, requestId)` unique index turns a repeat into a replay of the first result (`replayed: true`), never a second charge.

## Crash mechanics

- **Curve.** `m(t) = floor(100 · e^(0.00006 · t)) / 100`, where `t` is whole milliseconds since lift-off (`startsAt`, 1.5 s after the bet). That is 2× at 11.6 s, 10× at 38 s, and a hard cap of 1000× at about 115 s.
- **Crash point**, fixed when you bet:
  - `r = first 52 bits of HMAC_SHA256(serverSeed, clientSeed) / 2^52`
  - `cp = floor(95 / (1 − r)) / 100`, clamped to 1.00×–1000×
  - So `P(cp ≥ x) = 0.95 / x`: cashing out at any target returns 95% on average, and about 5% of rounds crash instantly at 1.00×.
- **Crashed** at time `t` when `m(t) ≥ cp`. A cash-out is valid only while `m(t) < cp`, and pays `m(t)` at the moment the request reaches the server. The client's idea of the multiplier is never trusted.
- **Auto cash-out** at target `a < cp` pays exactly `a`, even if no request is in flight. The round is settled lazily, by the long-poll or any read, at the exact time it reached `a`.
- **Real time without leaking the crash point.** The client animates the curve from `startsAt`, corrected for clock skew using the `serverNow` field in each response. It learns the outcome only from `GET /:id/wait`, which the server answers at the crash moment.
- **Example:** bet 100, cash out at 2.50× → payout 250, profit +150 (covered by a test).

## Mines multipliers

With `k` safe tiles found, the chance of having survived is `P(k) = C(7,k)/C(9,k)`. The game pays `0.95 / P(k)`, floored to 2 decimals:

| Safe tiles | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Win chance | 77.8% | 58.3% | 41.7% | 27.8% | 16.7% | 8.3% | 2.8% |
| Multiplier | 1.22× | 1.62× | 2.28× | 3.42× | 5.70× | 11.40× | 34.20× |

## Security and integrity

- **Identity.** `initData` is verified with HMAC-SHA256 against the bot token, using a constant-time compare and a max age (`TELEGRAM_INIT_DATA_MAX_AGE`). The client never sends a user id.
- **Server-side outcome.** Bombs are fixed when the game starts and stored with `select: false`. The API never returns them, or the server seed, while a game is active.
- **Provably fair.** The server commits to `sha256(serverSeed)` before the player picks `clientSeed`, and reveals the seed when the game ends. Bombs = Fisher–Yates over `HMAC_SHA256(serverSeed, clientSeed:round)`.
- **No double spend.**
  - A partial unique index allows one active game per user, and creating the game and debiting the bet happen in one transaction.
  - Debits are atomic (`balance >= amount` in the update filter).
- **Poop.** One active round per user (partial unique index). Every pick and the cash-out are conditional on `step`/`status`. The payout runs in the same transaction as its unique ledger key `poop:<id>:payout`, so a second cash-out gets 409 and pays nothing.
- **Roulette.** The stake debit is atomic (`balance >= stake`), so concurrent spins can never spend the same coins twice. Duplicates replay through the `requestId` unique index, and the ledger keys are `roulette:<id>:bet` and `roulette:<id>:payout`.
- **Crash.** One running round per user (partial unique index). Every settlement, whether manual, auto or crash, is a conditional update on `status: 'running'`, and a payout runs in the same transaction as its unique ledger key `crash:<id>:payout`. Ten parallel cash-outs pay once (covered by a test).
- **No double cash-out.**
  - Every move is conditional on the game's `step` (optimistic concurrency).
  - Settling and crediting happen in one transaction.
  - The ledger key `mines:<id>:payout` is unique.
- **Exact money.** Balances are integer units (1 coin = 100 units), so floating point never touches money.
- **Refresh and disconnect.** All game state lives on the server. `GET /games/mines/active` restores the game. An active game never expires: the bet stays at risk until the player continues.
- **Ledger.** Every balance change writes a `wallet_transactions` entry in the same transaction, for audit and reconciliation.
- **Rate limiting.**
  - Global: 60 requests per 10 s per IP.
  - Sign-in: 10 per minute.
  - Starting games: 20 per 10 s.

## Telegram setup

1. Create a bot with @BotFather and put the token in `TELEGRAM_BOT_TOKEN`.
2. Set `MINI_APP_URL` to the deployed Next.js URL (HTTPS). On startup the bot sets the chat menu button, and `/start` replies with a **Play** button.
3. Optional: in BotFather, `/newapp` creates a direct link `t.me/<bot>/<app>?startapp=…`. That value arrives as `startParam` at sign-in.
4. Prod runs in `webhook` mode (set by docker-compose), with Telegram posting to `https://tara.coolgards.com/api/telegram/webhook` (through the Next proxy). For a local bot, use `polling` only while the server is down.

## Deploy (Docker on a VPS, behind nginx)

`tara.coolgards.com` serves the Next.js app. Next proxies `/api/*` to this API over the compose network, so the API has no public port, no domain of its own and no CORS. Nothing uses port 3000.

```
Telegram ─► Cloudflare ─► nginx :443 ─► 127.0.0.1:47310  web (Next.js)
                                          └─ /api/* (Next rewrite) ─► api:47311  (NestJS) ─► Atlas
```

1. Clone both repos side by side on the server (`~/bet/bet-back`, `~/bet/bet-front`).
2. Put `.env` in `bet-back` (same file as local). `docker-compose.yml` overrides what differs in production: `NODE_ENV`, `PORT`, `TRUST_PROXY`, webhook mode and URL, `MINI_APP_URL` and `CORS_ORIGINS`. `TELEGRAM_WEBHOOK_SECRET` must be set.
3. `cd ~/bet/bet-back && docker compose up -d --build`
4. nginx: copy `deploy/nginx/tara.coolgards.com.conf` to `/etc/nginx/sites-available/`, symlink it into `sites-enabled`, then `nginx -t && systemctl reload nginx`.
5. In Atlas → Network Access, allow the VPS IP.
6. Check `https://tara.coolgards.com/api/health` → `{"status":"ok"}`, then send `/start` to the bot.

Only `127.0.0.1:47310` is published, so ufw needs no new rules. Override the host port with `WEB_PORT`, the domain with `PUBLIC_URL`, and the bot username with `BOT_USERNAME`.

The server registers the Telegram webhook (`https://tara.coolgards.com/api/telegram/webhook`) on startup. Keep `TELEGRAM_BOT_MODE=off` locally: a local API in `polling` mode would delete the server's webhook.

Update: `git pull` in both repos, then `docker compose up -d --build`.

## Product notes

### Technologies and AI tools
- **Stack:** NestJS 12, MongoDB Atlas (with transactions), Mongoose, Zod, grammY, Vitest. The frontend is Next.js 16, React 19 and Tailwind 4, using the Telegram WebApp SDK. Everything runs in Docker behind nginx and Cloudflare.
- **AI:** built with Claude Code (Claude Opus) as pair programmer: architecture, code, tests, debugging and UI. Every money path was then reviewed and covered by tests.

### Architecture
- The Telegram bot (`/start`) opens the Mini App.
- The app signs in with the signed `initData`, which the server verifies with HMAC before issuing a JWT.
- Each game is a self-contained Nest module and shares the wallet ledger. The Next.js server proxies `/api/*` to the API, so only one origin is public.

### Known limitations
- Single-player rounds: the other Crash players are simulated, labelled as such, and computed in the browser.
- The crash long-poll holds one HTTP request per running round. That's fine at this scale; at large scale, move it to WebSockets or SSE with one shared timer per round.
- A cash-out is valued when it *arrives*, so network latency costs the player a few hundredths of a multiplier. That's the safe direction: no latency compensation, no exploit.
- No leaderboard or referrals yet. Missions exist only for Poop so far, but the module is generic.

### Challenges and solutions
- **Real-time multiplier without revealing the crash point:** a deterministic curve on both sides, a clock-skew correction, and a long-poll that answers at the crash moment.
- **Double cash-out and double spend:** conditional status updates, a partial unique index, and unique ledger keys, all inside Mongo transactions.
- **Disconnects:** all state lives on the server. `/active` resumes a round, rounds settle lazily, and the client re-reads its state when the app comes back to the foreground or the network returns.
- **Windows DNS refusing Atlas SRV lookups:** Node's resolver is pointed at public DNS (`src/common/dns.ts`).

### With 4 more hours
I'd build a **real-time shared Roulette/Crash table over WebSockets**: one wheel every 20–30 s for everyone, live bets from real players, and a leaderboard. Today each player spins alone. Shared rounds are what make these games social and bring people back, and the server design (stateless settlement, idempotent requests, ledger keys) already supports it.

### Future improvements
- Real multiplayer Crash: shared rounds over WebSockets, with a live list of other players' bets.
- A leaderboard by total profit, and referral bonuses using `startParam`.
- Sound effects and a cash-out streak/achievement system.
- An admin dashboard for ledger reconciliation and RTP monitoring.
