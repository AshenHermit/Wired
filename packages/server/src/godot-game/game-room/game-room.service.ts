import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  GameConnectionErrorCode,
  GameRoomConnection,
  GameRoomRuntimeStatus,
  RoomPackagesStatus,
  activePackages,
  packagesApplied,
} from '@wired-io/shared';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { RoomsService } from 'src/rooms/rooms.service';
import { canViewRoom } from 'src/rooms/room-access';
import { GameRoomTicketRateLimiter } from './game-room.rate-limiter';
import { PackageSyncService } from '../package-sync/package-sync.service';
import { RoomRuntimeError, RoomRuntimeErrorCode } from '../runtime/room-runtime.errors';
import { RoomRuntimeService } from '../runtime/room-runtime.service';
import type { RoomConnection } from '../runtime/room-runtime.types';

const STATUS_BY_ERROR: Record<RoomRuntimeErrorCode, HttpStatus> = {
  invalid_room: HttpStatus.BAD_REQUEST,
  config: HttpStatus.SERVICE_UNAVAILABLE,
  ticket_secret_missing: HttpStatus.SERVICE_UNAVAILABLE,
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
  room_stopping: 'The room runtime is stopping; retry shortly',
  room_not_running: 'The room runtime is not running',
  handshake_window_expired:
    'The connection window expired; retry to restart the room',
  start_failed: 'The Godot runtime for this room failed to start',
};

const PACKAGE_READY_TIMEOUT_MS = 10_000;
const PACKAGE_READY_POLL_MS = 100;

/** One body shape for every connection failure, keyed by a shared wire code. */
function connectionFailure(
  status: HttpStatus,
  code: GameConnectionErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException(
    { statusCode: status, code, message, ...extra },
    status,
  );
}

@Injectable()
export class GameRoomService {
  private readonly logger = new Logger(GameRoomService.name);

  constructor(
    private readonly rooms: RoomsService,
    private readonly runtime: RoomRuntimeService,
    private readonly rateLimiter: GameRoomTicketRateLimiter,
    private readonly packageSync: PackageSyncService,
  ) {}

  /**
   * Starts or reuses the room runtime and mints a single-use ticket. Access is
   * checked against the database room, never against the id sent by a client.
   */
  async connect(
    user: User,
    roomId: number,
  ): Promise<GameRoomConnection> {
    const { room, user: player } = await this.assertCanPlay(user, roomId);
    const limit = this.rateLimiter.consume(player.id, room.id);
    if (!limit.allowed) {
      throw connectionFailure(
        HttpStatus.TOO_MANY_REQUESTS,
        'rate_limited',
        `Too many connection attempts; retry in ${limit.retryAfterSeconds}s`,
        { retryAfterSeconds: limit.retryAfterSeconds },
      );
    }

    const runtimeRoomId = String(room.id);
    let connection: RoomConnection;
    try {
      // Starting the process is what makes the room apply its
      // packages, so the mint happens before the readiness wait; re-minting
      // afterwards would discard the first ticket and can stop the runtime
      // through the handshake window. The ticket TTL (60s by default) is
      // comfortably larger than the bounded readiness wait (10s), so the
      // browser still receives a usable window.
      connection = await this.runtime.connectRoom(runtimeRoomId);
      await this.waitForInitialPackages(runtimeRoomId);
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
    user: User,
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

  /**
   * Package application state for the room's runtime and clients. Reads
   * in-memory bookkeeping only; the published manifest remains authoritative.
   * Never starts the runtime.
   */
  async getPackages(
    user: User,
    roomId: number,
  ): Promise<RoomPackagesStatus> {
    const { room } = await this.assertCanPlay(user, roomId);
    return {
      roomId: room.id,
      packages: await this.packageSync.getStatuses(String(room.id)),
    };
  }

  private async waitForInitialPackages(roomId: string): Promise<void> {
    const deadline = Date.now() + PACKAGE_READY_TIMEOUT_MS;
    for (;;) {
      const status: RoomPackagesStatus = {
        roomId: Number(roomId),
        packages: await this.packageSync.getStatuses(roomId),
      };
      const active = new Set(
        activePackages(status).map(({ packageId }) => packageId),
      );
      if (
        status.packages.some(
          (entry) => active.has(entry.packageId) && entry.runtime.state === 'failed',
        )
      ) {
        throw connectionFailure(
          HttpStatus.BAD_GATEWAY,
          'packages_failed',
          'Room packages failed to apply',
        );
      }
      if (packagesApplied(status)) return;
      if (Date.now() >= deadline) {
        throw connectionFailure(
          HttpStatus.CONFLICT,
          'packages_pending',
          'Room packages are still applying; retry shortly',
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PACKAGE_READY_POLL_MS),
      );
    }
  }

  private async assertCanPlay(
    user: User,
    roomId: number,
  ): Promise<{ room: Room; user: User }> {
    const room = await this.rooms.findOne(roomId);

    if (room.type !== 'godot') {
      throw new BadRequestException(
        `Room ${roomId} is not a Godot room and cannot be played`,
      );
    }

    if (room.isPublic) {
      return { room, user };
    }

    if (!canViewRoom(room, user.id)) {
      throw new ForbiddenException(
        `Room ${roomId} is private; only its author and contributors can play it`,
      );
    }

    return { room, user };
  }

  private toHttpException(error: unknown, roomId: string): HttpException {
    if (!(error instanceof RoomRuntimeError)) {
      if (error instanceof HttpException) return error;
      // Nothing else maps to a status, so the client only sees a generic 500.
      // Log the original so the cause survives instead of being swallowed.
      this.logger.error(
        `Game room ${roomId} connection failed unexpectedly`,
        error instanceof Error ? error.stack : String(error),
      );
      return new HttpException(
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
