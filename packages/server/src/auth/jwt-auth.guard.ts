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
  handleRequest<TUser = User | null>(
    err: any,
    user: TUser,
    info: any,
    context: ExecutionContext,
    status?: any,
  ): TUser {
    return user ?? (null as TUser);
  }
}
