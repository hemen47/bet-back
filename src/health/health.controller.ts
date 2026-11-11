import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { InjectConnection } from '@nestjs/mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import type { Connection } from 'mongoose';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  async check() {
    try {
      await this.connection.db!.admin().ping();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
