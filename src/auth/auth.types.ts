/** What `@CurrentUser()` returns: read from the verified JWT, no DB hit. */
export interface AuthUser {
  id: string;
  telegramId: number;
}

declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: AuthUser;
    refreshTokens: false;
  }
}
