import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_POLICY_KEY } from './auth-policy';
import { DefaultAuthGuard } from './default-auth.guard';
import { JwtAuthGuard, JwtSilentAuthGuard } from './jwt.guard';

describe('DefaultAuthGuard', () => {
  const required = { canActivate: jest.fn() };
  const silent = { canActivate: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new DefaultAuthGuard(
    reflector as unknown as Reflector,
    required as unknown as JwtAuthGuard,
    silent as unknown as JwtSilentAuthGuard,
  );
  const handler = () => undefined;
  class Controller {}
  const context = {
    getHandler: () => handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;

  const policy = (value: string | undefined) =>
    reflector.getAllAndOverride.mockReturnValue(value);

  beforeEach(() => {
    jest.clearAllMocks();
    required.canActivate.mockResolvedValue(true);
    silent.canActivate.mockResolvedValue(true);
  });

  it('authenticates a handler that declares no policy', async () => {
    policy(undefined);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(AUTH_POLICY_KEY, [
      handler,
      Controller,
    ]);
    expect(required.canActivate).toHaveBeenCalledWith(context);
    expect(silent.canActivate).not.toHaveBeenCalled();
  });

  it('lets a handler marked public through without touching passport', async () => {
    policy('public');

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(required.canActivate).not.toHaveBeenCalled();
    expect(silent.canActivate).not.toHaveBeenCalled();
  });

  it('uses the silent strategy for a handler that accepts anonymous callers', async () => {
    policy('silent');

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(silent.canActivate).toHaveBeenCalledWith(context);
    expect(required.canActivate).not.toHaveBeenCalled();
  });

  it('propagates the rejection of the required guard', async () => {
    policy('required');
    required.canActivate.mockRejectedValue(new UnauthorizedException());

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
