import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { packageError } from '../package-errors';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { RuntimeAuthRequest } from 'src/auth/jwt.strategy';
import { canReadRoom } from 'src/rooms/room-access';
import { readPositiveInt } from './request-ids';
import { isRuntimeServiceUser } from 'src/auth/runtime-service-user';

/**
 * Authoritative access check for room-scoped package runtime delivery.
 *
 * The endpoint reads `packageId` from the path and `roomId` from `?room=`.
 * Without this guard, knowing two enumerable integer ids is enough to mint a
 * signed download token for any package of any room. Both relations are
 * verified here, before any artifact is built or streamed:
 *  - the authenticated user must be allowed to read the room (canReadRoom);
 *  - the package must be attached to that exact room.
 *
 * It throws 403 instead of 404 so a member probing package ids learns nothing
 * beyond "not yours", while non-members cannot distinguish private rooms from
 * missing ones.
 */
@Injectable()
export class RoomMembershipGuard implements CanActivate {
  constructor(
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RuntimeAuthRequest>();
    const user = request?.user;
    if (!user) {
      throw packageError(
        'authentication_required',
        'Sign in to read this package',
      );
    }

    const roomId = readPositiveInt(request.query?.room);
    const packageId = readPositiveInt(request.params?.id);
    if (roomId === null || packageId === null) {
      throw packageError('room_access_denied', 'You cannot read this room');
    }

    const room = await this.roomsRepository.findOne({
      where: { id: roomId },
      relations: ['author', 'contributors'],
    });
    // The room's own runtime is not a user, so it has no membership row. It is
    // still confined to its room: the package binding below applies to it too.
    if (
      !room ||
      (!isRuntimeServiceUser(user) && !canReadRoom(room, user.id))
    ) {
      throw packageError('room_access_denied', 'You cannot read this room');
    }

    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      relations: ['room'],
    });
    if (!pkg || pkg.room?.id !== roomId) {
      throw packageError(
        'package_not_attached_to_room',
        'This package does not belong to the requested room',
      );
    }

    return true;
  }
}
