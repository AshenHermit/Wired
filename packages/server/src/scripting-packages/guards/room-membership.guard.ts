import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';

type RoomMemberSubject = {
  author?: { id: number } | null;
  contributors?: { id: number }[] | null;
};

/** A room member is explicitly listed: its author or one of its contributors. */
export function isRoomMember(
  room: RoomMemberSubject,
  userId?: number | null,
): boolean {
  if (userId == null) return false;
  if (room.author?.id === userId) return true;
  return (room.contributors ?? []).some(
    (contributor) => contributor.id === userId,
  );
}

/** Route/query ids arrive as raw strings: guards run before ParseIntPipe. */
function readId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Authoritative access check for room-scoped package runtime delivery.
 *
 * The endpoint reads `packageId` from the path and `roomId` from `?room=`.
 * Without this guard, knowing two enumerable integer ids is enough to mint a
 * signed download token for any package of any room. Both relations are
 * verified here, before any artifact is built or streamed:
 *  - the authenticated user must be a member (author/contributor) of the room;
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
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request?.user;
    if (!user) {
      throw new UnauthorizedException('authentication_required');
    }

    const roomId = readId(request.query?.room);
    const packageId = readId(request.params?.id);
    if (roomId === null || packageId === null) {
      throw new ForbiddenException('room_access_denied');
    }

    const room = await this.roomsRepository.findOne({
      where: { id: roomId },
      relations: ['author', 'contributors'],
    });
    if (!room || !isRoomMember(room, user.id)) {
      throw new ForbiddenException('room_access_denied');
    }

    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      relations: ['room'],
    });
    if (!pkg || pkg.room?.id !== roomId) {
      throw new ForbiddenException('package_not_attached_to_room');
    }

    return true;
  }
}
