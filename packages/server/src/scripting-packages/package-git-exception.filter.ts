import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { errorMessage } from 'src/common/errors';
import { GitCommandError } from './storage/git/git-command';

/**
 * Maps a failed git process to a retryable 503 with a stable code.
 *
 * Git failures are infrastructure failures (timeout, disk full, a repository
 * being repaired), so the client must be able to tell them from a rejected
 * request: every other publication error is a 4xx with its own code.
 */
@Catch(GitCommandError)
export class PackageGitExceptionFilter implements ExceptionFilter<GitCommandError> {
  private readonly logger = new Logger(PackageGitExceptionFilter.name);

  catch(exception: GitCommandError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    this.logger.error(`git command failed: ${errorMessage(exception)}`);
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'package_storage_failed',
      message: 'Package storage is temporarily unavailable, try again',
    });
  }
}
