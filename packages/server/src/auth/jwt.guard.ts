import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { User } from 'src/database/entities/user.entity';

/**
 * Passport guards used by `DefaultAuthGuard`.
 *
 * Routes do not reference these directly: they declare a policy with
 * `@UseAuthGuard()`, `@SilentAuth()` or `@Public()` from `auth-policy.ts`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

@Injectable()
export class JwtSilentAuthGuard extends AuthGuard('jwt-silent') {
  /**
   * Passport answers a rejected token with `false`, not `null`, and
   * `false ?? null` would stay `false` — so the silent guard has to normalise
   * the result to match what `SilentAuthRequest.user` promises.
   */
  handleRequest<TUser = User | null>(
    err: unknown,
    user: unknown,
    info: unknown,
    context: ExecutionContext,
    status?: unknown,
  ): TUser {
    return (user ? user : null) as TUser;
  }
}
