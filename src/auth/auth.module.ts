import { Module } from '@nestjs/common';
import { AuthenticationModule } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { UsersModule } from '../users/users.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthProvider } from './jwt-auth.provider.js';
import './auth.types.js';

export const JWT_ISSUER = 'bet-api';
export const JWT_AUDIENCE = 'bet-miniapp';

@Module({
  imports: [
    // Registers a global guard: every route needs a valid bearer token
    // unless marked @Public().
    AuthenticationModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        accessToken: {
          key: config.get('JWT_SECRET', { infer: true }),
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          ttl: config.get('JWT_TTL', { infer: true }),
        },
        // Short-lived access token only; the Mini App signs in again with
        // fresh initData when it expires. Nothing to store server-side.
        refreshToken: false,
      }),
    }),
    UsersModule,
    WalletModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthProvider],
})
export class AuthModule {}
