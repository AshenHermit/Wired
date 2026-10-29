import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { GameTicketService } from './game-ticket.service';
import { RoomRuntimeConfiguration } from './room-runtime.configuration';
import { RoomRuntimeError } from './room-runtime.errors';
import { RoomRuntimeRegistry } from './room-runtime.registry';
import { RoomRuntimeSession } from './room-runtime.session';
import {
  RoomConnection,
  RoomRuntimeInfo,
  RuntimeProcessFactory,
} from './room-runtime.types';

/**
 * Facade over the runtime sessions of a room.
 *
 * The registry part is deliberately small: validate the room, allocate a
 * port, start one session and route public calls to it. Everything that
 * belongs to a single process (stdout protocol, readiness, handshake lease,
 * idle timeout, stop sequence) lives in RoomRuntimeSession.
 *
 * One runtime exists per room at a time. Concurrent connection requests share
 * the same in-flight session (single-flight), so parallel tabs cannot spawn
 * duplicate processes. The session key is `roomId:port`, which keeps a
 * restarted room distinguishable from its previous process.
 */
@Injectable()
export class RoomRuntimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RoomRuntimeService.name);
  private readonly registry = new RoomRuntimeRegistry();
  private readonly runtimeConfiguration: RoomRuntimeConfiguration;
  private readonly sessions = new Map<string, RoomRuntimeSession>();

  constructor(
    private readonly configService: AppConfigService,
    private readonly processFactory: RuntimeProcessFactory,
    private readonly tickets: GameTicketService,
  ) {
    this.runtimeConfiguration = new RoomRuntimeConfiguration(configService);
  }

  /**
   * Returns a ready runtime for the room, starting the process if needed.
   * Rejects with an explicit lifecycle error when the room cannot start; it
   * never falls back to a "maybe works" endpoint.
   */
  async getConnection(roomId: string): Promise<RoomConnection> {
    const session = this.ensureSession(roomId);
    await session.readyPromise;

    const ticketTtlSec = session.reserveConnection();
    const ticket = this.tickets.mint(roomId, ticketTtlSec);
    return {
      ...session.info(),
      ticket: ticket.ticket,
      ticketExpiresAt: ticket.expiresAt,
    };
  }

  /** Current runtime status; never starts a process. */
  getRuntime(roomId: string): RoomRuntimeInfo | null {
    return this.sessions.get(roomId)?.info() ?? null;
  }

  listRuntimes(): RoomRuntimeInfo[] {
    return [...this.sessions.values()].map((session) => session.info());
  }

  getLogs(roomId: string): string[] {
    return this.sessions.get(roomId)?.logLines() ?? [];
  }

  stopRoom(roomId: string, reason = 'requested'): Promise<void> {
    const session = this.sessions.get(roomId);
    if (!session) {
      return Promise.reject(
        new RoomRuntimeError(
          'room_not_running',
          `Room ${roomId} has no runtime`,
          roomId,
        ),
      );
    }
    return session.stop(reason);
  }

  /** Stops every room; used by Nest shutdown hooks so no process is orphaned. */
  async shutdownAll(): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) =>
      session.isActive(),
    );
    await Promise.all(
      sessions.map((session) =>
        session.stop('backend_shutdown').catch((error) => {
          this.logger.error(
            `Failed to stop room ${session.roomId}: ${this.errorMessage(error)}`,
          );
        }),
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdownAll();
  }

  // --- startup ------------------------------------------------------------

  private ensureSession(roomId: string): RoomRuntimeSession {
    this.runtimeConfiguration.validateRoomId(roomId);
    const config = this.configService.godotRuntime;
    this.runtimeConfiguration.validate(config);
    const paths = this.runtimeConfiguration.resolvePaths(config);

    const existing = this.sessions.get(roomId);
    if (existing) {
      if (existing.state === 'starting' || existing.state === 'running') {
        return existing;
      }
      if (existing.state === 'stopping') {
        throw new RoomRuntimeError(
          'room_stopping',
          `Room ${roomId} is stopping; retry after it exits`,
          roomId,
          existing.port,
        );
      }
    }

    const port = this.registry.allocatePort(config);
    if (port === null) {
      throw new RoomRuntimeError(
        'start_failed',
        `No free port in range ${config.portStart}-${config.portEnd}`,
        roomId,
      );
    }

    const session = new RoomRuntimeSession({
      roomId,
      port,
      config,
      paths,
      configuration: this.runtimeConfiguration,
      processFactory: this.processFactory,
      registry: this.registry,
      logger: this.logger,
    });
    this.sessions.set(roomId, session);
    this.registry.add(session.record);
    session.start();
    return session;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
