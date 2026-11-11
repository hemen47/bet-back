import {
  Catch,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import mongoose from 'mongoose';

const { MongoNetworkError, MongoServerSelectionError } = mongoose.mongo;

/**
 * A dropped or refused database connection is transient, and any
 * transaction that was open has been aborted (no money moved). Answer
 * 503 with a stable code instead of a generic 500, so the client knows to
 * re-read its state and retry.
 */
@Catch(MongoNetworkError, MongoServerSelectionError)
export class MongoUnavailableFilter implements ExceptionFilter {
  private readonly logger = new Logger(MongoUnavailableFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(error: Error, host: ArgumentsHost): void {
    this.logger.warn(`Database unavailable: ${error.message}`);
    const { httpAdapter } = this.adapterHost;
    httpAdapter.reply(
      host.switchToHttp().getResponse(),
      {
        statusCode: 503,
        error: 'db_unavailable',
        message: 'Temporary problem, please try again',
      },
      503,
    );
  }
}
