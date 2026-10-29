import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { GameRoomConnection, GameRoomRuntimeStatus } from '@wired-io/shared';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { RoomsService } from 'src/rooms/rooms.service';
import { GameRoomTicketRateLimiter } from './game-room.rate-limiter';
import { RoomRuntimeError, RoomRuntimeErrorCode } from './room-runtime.errors';
import { RoomRuntimeService } from './room-runtime.service';
import type { RoomConnection } from './room-runtime.types';

const STATUS_BY_ERROR: Record<RoomRuntimeErrorCode, HttpStatus> = {
  invalid_room: HttpStatus.BAD_REQUEST,
  config: HttpStatus.SERVICE_UNAVAILABLE,
  ticket_secret_missing: HttpStatus.SERVICE_UNAVAILABLE,
  room_starting: HttpStatus.CONFLICT,
  room_stopping: HttpStatus.CONFLICT,
  room_not_running: HttpStatus.CONFLICT,
  handshake_window_expired: HttpStatus.CONFLICT,
  start_failed: HttpStatus.BAD_GATEWAY,
};

/**
 * Public messages deliberately omit ports, pids and paths: those details stay
 * in the runtime log, the client only needs to know what to do next.
 */
const MESSAGE_BY_ERROR: Record<RoomRuntimeErrorCode, string> = {
  invalid_room: 'Invalid room identifier',
  config: 'The Godot runtime is not configured on this server',
  ticket_secret_missing: 'Game tickets are not configured on this server',
  room_starting: 'The room runtime is starting; retry shortly',
  room_stopping: 'The room runtime is stopping; retry shortly',
  room_not_running: 'The room runtime is not running',
  handshake_window_expired:
    'The connection window expired; retry to restart the room',
  start_failed: 'The Godot runtime for this room failed to start',
};

@Injectable()
export class GameRoomService {
  private readonly logger = new Logger(GameRoomService.name);

  constructor(
    private readonly rooms: RoomsService,
    private readonly runtime: RoomRuntimeService,
    private readonly rateLimiter: GameRoomTicketRateLimiter,
  ) {}

  /**
   * Starts or reuses the room runtime and mints a single-use ticket. Access is
   * checked against the database room, never against the id sent by a client.
   */
  async connect(
    user: User | undefined,
    roomId: number,
  ): Promise<GameRoomConnection> {
    const { room, user: player } = await this.assertCanPlay(user, roomId);
    const limit = this.rateLimiter.consume(player.id, room.id);
    if (!limit.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'rate_limited',
          message: `Too many connection attempts; retry in ${limit.retryAfterSeconds}s`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const runtimeRoomId = String(room.id);
    let connection: RoomConnection;
    try {
      connection = await this.runtime.getConnection(runtimeRoomId);
    } catch (error) {
      throw this.toHttpException(error, runtimeRoomId);
    }

    return {
      roomId: room.id,
      endpoint: connection.endpoint,
      ticket: connection.ticket,
      ticketExpiresAt: connection.ticketExpiresAt,
      activePlayers: connection.activePlayers,
    };
  }

  /** Reads the runtime state; this path never starts Godot. */
  async getStatus(
    user: User | undefined,
    roomId: number,
  ): Promise<GameRoomRuntimeStatus> {
    const { room } = await this.assertCanPlay(user, roomId);
    const info = this.runtime.getRuntime(String(room.id));
    return {
      roomId: room.id,
      state: info?.state ?? 'idle',
      endpoint: info?.endpoint ?? null,
      activePlayers: info?.activePlayers ?? 0,
      error: info?.state === 'failed' ? 'Godot runtime failed to start' : null,
    };
  }

  private async assertCanPlay(
    user: User | undefined,
    roomId: number,
  ): Promise<{ room: Room; user: User }> {
    if (!user || typeof user.id !== 'number') {
      throw new UnauthorizedException('Sign in to join a game room');
    }

    const room = await this.rooms.findOne(roomId);

    if (room.type !== 'godot') {
      throw new BadRequestException(
        `Room ${roomId} is not a Godot room and cannot be played`,
      );
    }

    if (room.isPublic) {
      return { room, user };
    }

    const isAuthor = room.author?.id === user.id;
    const isContributor = (room.contributors ?? []).some(
      (contributor) => contributor.id === user.id,
    );
    if (!isAuthor && !isContributor) {
      throw new ForbiddenException(
        `Room ${roomId} is private; only its author and contributors can play it`,
      );
    }

    return { room, user };
  }

  private toHttpException(error: unknown, roomId: string): HttpException {
    if (!(error instanceof RoomRuntimeError)) {
      return error instanceof HttpException
        ? error
        : new HttpException(
            'Cannot start the room runtime',
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
    }
    const status =
      STATUS_BY_ERROR[error.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    this.logger.warn(
      `Game room ${roomId} connection failed with ${error.code}: ${error.message}`,
    );
    return new HttpException(
      {
        statusCode: status,
        code: error.code,
        message:
          MESSAGE_BY_ERROR[error.code] ?? 'Cannot start the room runtime',
      },
      status,
    );
  }
}
