import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { createRuntimeServiceToken } from 'src/common/runtime-contracts';
import { RuntimeAuthGuard } from './runtime-auth.guard';
import { isRuntimeServiceUser } from 'src/auth/runtime-service-user';

function context(
  query: Record<string, string>,
  authorization?: string,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ query, headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('RuntimeAuthGuard', () => {
  const config = {
    godotRuntime: { ticketSecret: 'secret' },
  } as unknown as AppConfigService;
  const guard = new RuntimeAuthGuard(config);

  it('passes a JWT-authenticated user through', () => {
    const user = { id: 7 };

    expect(guard.handleRequest(null, user, null, context({ room: '42' }))).toBe(
      user,
    );
  });

  it('accepts a valid room-scoped service token', () => {
    const token = createRuntimeServiceToken('secret', '42');

    const result = guard.handleRequest(
      null,
      false,
      null,
      context({ room: '42' }, `Bearer ${token}`),
    );

    expect(isRuntimeServiceUser(result)).toBe(true);
    expect(isRuntimeServiceUser(result) && result.id).toBe(0);
  });

  it('rejects a service token issued for another room', () => {
    const token = createRuntimeServiceToken('secret', '43');

    expect(() =>
      guard.handleRequest(
        null,
        false,
        null,
        context({ room: '42' }, `Bearer ${token}`),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a request with no credentials', () => {
    expect(() =>
      guard.handleRequest(null, false, null, context({ room: '42' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a service token when the route has no valid room', () => {
    const token = createRuntimeServiceToken('secret', '42');

    expect(() =>
      guard.handleRequest(null, false, null, context({}, `Bearer ${token}`)),
    ).toThrow(UnauthorizedException);
  });
});
