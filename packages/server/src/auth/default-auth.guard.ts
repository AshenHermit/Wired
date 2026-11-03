import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_POLICY_KEY, AuthPolicy } from './auth-policy';
import { JwtAuthGuard, JwtSilentAuthGuard } from './jwt-auth.guard';

/**
 * Makes authentication the default for every route.
 *
 * Registered as an `APP_GUARD`, so it runs before any handler-level guard and
 * covers controllers that declare nothing. Handlers opt out with `@Public()`
 * or soften it with `@SilentAuth()`; anything else is authenticated with the
 * regular JWT strategy.
 */
@Injectable()
export class DefaultAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly required: JwtAuthGuard,
    private readonly silent: JwtSilentAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy =
      this.reflector.getAllAndOverride<AuthPolicy>(AUTH_POLICY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'required';

    if (policy === 'public') {
      return true;
    }

    const guard = policy === 'silent' ? this.silent : this.required;
    return Boolean(await guard.canActivate(context));
  }
}
