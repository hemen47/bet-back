import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  JwtBearerProvider,
  type JwtClaims,
} from '@nestjs/authentication';
import type { AuthUser } from './auth.types.js';

/**
 * Accepts `Authorization: Bearer <jwt>` signed by `TokenService` (see
 * AuthService). The token carries the user id and Telegram id.
 */
@Injectable()
export class JwtAuthProvider extends JwtBearerProvider<AuthUser> {
  constructor(registry: AuthenticationRegistry) {
    super();
    registry.registerProvider(this);
  }

  protected validate(claims: JwtClaims): AuthUser | null {
    const tid = claims.tid;
    if (!claims.sub || typeof tid !== 'number') return null;
    return { id: claims.sub, telegramId: tid };
  }
}
