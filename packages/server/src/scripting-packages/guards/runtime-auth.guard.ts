import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AppConfigService } from 'src/config/config.service';
import { verifyRuntimeServiceToken } from 'src/common/runtime-contracts';
import type { RequestPrincipal } from 'src/auth/jwt.strategy';
import type { User } from 'src/database/entities/user.entity';
import { readPositiveInt } from './request-ids';
import { createRuntimeServiceUser } from 'src/auth/runtime-service-user';

/**
 * Authentication for the room-scoped package runtime routes.
 *
 * A logged-in user proves identity with the normal JWT: membership is then
 * checked by `RoomMembershipGuard`. The native Godot runtime has no user, so it
 * presents a room-scoped service token instead; it only ever reads packages of
 * the room it is running for.
 *
 * Delegating to `AuthGuard('jwt')` keeps JWT validation in one place: when
 * passport rejects the header, `handleRequest` falls back to the service token.
 */
@Injectable()
export class RuntimeAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly configService: AppConfigService) {
    super();
  }

  /**
   * The generic exists only because `IAuthGuard` declares one; passport never
   * passes a type argument, so `TUser` is always `RequestPrincipal` here.
   */
  handleRequest<TUser = RequestPrincipal>(
    err: unknown,
    user: unknown,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (user) {
      return user as TUser;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const roomId = readPositiveInt(request.query?.room);
    if (
      roomId !== null &&
      verifyRuntimeServiceToken(
        this.configService.godotRuntime.ticketSecret,
        roomId,
        request.headers.authorization,
      )
    ) {
      return createRuntimeServiceUser() as TUser;
    }

    throw err ?? new UnauthorizedException('authentication_required');
  }
}
