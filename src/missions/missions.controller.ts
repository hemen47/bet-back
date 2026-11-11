import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { z } from 'zod';
import { MissionsService } from './missions.service.js';

const missionId = z.string().regex(/^[a-z0-9_]{1,40}$/, 'invalid mission id');

@Controller('missions')
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  /** Today's missions with your progress. Resets at 00:00 UTC. */
  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.missions.list(userId);
  }

  /** 400 `mission_incomplete`, 409 `already_claimed`. */
  @Post(':id/claim')
  @HttpCode(200)
  claim(
    @CurrentUser('id') userId: string,
    @Param('id', { schema: missionId }) id: string,
  ) {
    return this.missions.claim(userId, id);
  }
}
