import { HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { GitCommandError } from './storage/git/git-command';
import { PackageGitExceptionFilter } from './package-git-exception.filter';

describe('PackageGitExceptionFilter', () => {
  it('maps a git failure to a retryable 503', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ headersSent: false, status }),
      }),
    } as unknown as ArgumentsHost;

    new PackageGitExceptionFilter().catch(
      new GitCommandError(['write-tree'], 128, 'fatal: bad object'),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'package_storage_failed' }),
    );
  });

  it('ends an already started response instead of writing JSON', () => {
    const end = jest.fn();
    const status = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ headersSent: true, status, end }),
      }),
    } as unknown as ArgumentsHost;

    new PackageGitExceptionFilter().catch(
      new GitCommandError(['cat-file'], 1, 'broken pipe'),
      host,
    );

    expect(end).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
