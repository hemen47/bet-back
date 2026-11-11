import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { MongoUnavailableFilter } from './common/mongo-unavailable.filter.js';
import { envSchema, type Env } from './config/env.schema.js';
import { CrashModule } from './games/crash/crash.module.js';
import { MinesModule } from './games/mines/mines.module.js';
import { PoopModule } from './games/poop/poop.module.js';
import { RouletteModule } from './games/roulette/roulette.module.js';
import { MissionsModule } from './missions/missions.module.js';
import { HealthController } from './health/health.controller.js';
import { RewardsModule } from './rewards/rewards.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { UsersModule } from './users/users.module.js';
import { WalletModule } from './wallet/wallet.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        // Keep TLS connections warm: a burst of requests must not each open
        // a new connection (Atlas throttles new-connection bursts).
        minPoolSize: 5,
        maxPoolSize: 20,
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 10_000, limit: 60 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    AuthModule,
    UsersModule,
    WalletModule,
    RewardsModule,
    TelegramModule,
    // Games: one module each.
    MinesModule,
    CrashModule,
    RouletteModule,
    PoopModule,
    MissionsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: MongoUnavailableFilter },
  ],
})
export class AppModule {}
