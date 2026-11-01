import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { GameTicketService } from './game-ticket.service';
import { RoomRuntimeConfiguration } from './room-runtime.configuration';
import { RoomRuntimeError } from './room-runtime.errors';
import { RoomRuntimeRegistry } from './room-runtime.registry';
import { RoomRuntimeSession } from './room-runtime.session';
import { RuntimeLineEvent } from './room-runtime.line-parser';
import {
  RoomConnection,
  RoomRuntimeInfo,
  RuntimeObserver,
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
  private observer?: RuntimeObserver;

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

  /**
   * Mints a fresh ticket for an already running room. Used after a readiness
   * wait, which can consume most of the original ticket's TTL. The handshake
   * lease is renewed through `reserveConnection`, and a room that is no longer
   * playable fails with the same explicit lifecycle error as `getConnection`.
   */
  refreshConnection(roomId: string): RoomConnection {
    const session = this.registry.get(roomId);
    if (!session || !session.isActive()) {
      throw new RoomRuntimeError(
        'room_not_running',
        `Room ${roomId} has no running runtime`,
        roomId,
      );
    }
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
    return this.registry.get(roomId)?.info() ?? null;
  }

  listRuntimes(): RoomRuntimeInfo[] {
    return this.registry.list().map((session) => session.info());
  }

  getLogs(roomId: string): string[] {
    return this.registry.get(roomId)?.logLines() ?? [];
  }

  /**
   * Registers the local observer of runtime protocol events. There is exactly
   * one consumer (package sync); passing undefined unregisters it.
   */
  setObserver(observer: RuntimeObserver | undefined): void {
    this.observer = observer;
  }

  /**
   * Sends a package revision command to a running room. Returns false when the
   * runtime is absent or not running, so the caller can retry after readiness.
   */
  sendPackage(roomId: string, packageId: number, revision: number): boolean {
    return this.registry.get(roomId)?.sendPackage(packageId, revision) ?? false;
  }

  async stopRoom(roomId: string, reason = 'requested'): Promise<void> {
    const session = this.registry.get(roomId);
    if (!session) {
      return Promise.reject(
        new RoomRuntimeError(
          'room_not_running',
          `Room ${roomId} has no runtime`,
          roomId,
        ),
      );
    }
    await session.stop(reason);
    if (!session.canBeStopped()) {
      // The process really exited: drop the record so the room does not keep
      // a stale session (and its log buffer) after an explicit stop.
      this.forgetSession(roomId);
    }
  }

  /** Stops every room; used by Nest shutdown hooks so no process is orphaned. */
  async shutdownAll(): Promise<void> {
    // `canBeStopped` and not `isActive`: a runtime that survived a force kill
    // is already `failed`, but it still holds its port until it really exits.
    const sessions = this.registry
      .list()
      .filter((session) => session.canBeStopped());
    await Promise.all(
      sessions.map((session) =>
        session.stop('backend_shutdown').catch((error) => {
          this.logger.error(
            `Failed to stop room ${session.roomId}: ${this.errorMessage(error)}`,
          );
        }),
      ),
    );
    for (const session of sessions) {
      if (!session.canBeStopped()) {
        this.forgetSession(session.roomId);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdownAll();
  }

  /**
   * Drops a stopped session so the room no longer keeps a record (and its log
   * buffer) after it is gone. The port was already released by the exit.
   */
  private forgetSession(roomId: string): void {
    this.registry.remove(roomId);
  }

  // --- startup ------------------------------------------------------------

  private ensureSession(roomId: string): RoomRuntimeSession {
    this.runtimeConfiguration.validateRoomId(roomId);
    const config = this.configService.godotRuntime;
    this.runtimeConfiguration.validate(config);
    const paths = this.runtimeConfiguration.resolvePaths(config);

    const existing = this.registry.get(roomId);
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
      onEvent: (event) =>
        this.handleSessionEvent(roomId, event),
    });
    this.registry.add(session);
    session.start();
    return session;
  }

  private handleSessionEvent(roomId: string, event: RuntimeLineEvent): void {
    const observer = this.observer;
    if (!observer) {
      return;
    }
    try {
      switch (event.kind) {
        case 'ready':
          observer.onRuntimeReady?.(roomId);
          return;
        case 'auth':
          observer.onPeerAuthenticated?.(roomId, event.peer);
          return;
        case 'player-left':
          observer.onPeerLeft?.(roomId, event.peer);
          return;
        case 'packages-applied':
          observer.onPackagesApplied?.(
            roomId,
            event.packageId,
            event.revision,
            event.files,
          );
          return;
        case 'packages-failed':
          observer.onPackagesFailed?.(
            roomId,
            event.packageId,
            event.revision,
            event.error,
          );
          return;
        case 'client-packages-ready':
          observer.onClientPackagesReady?.(
            roomId,
            event.peer,
            event.packageId,
            event.revision,
          );
          return;
        case 'client-packages-failed':
          observer.onClientPackagesFailed?.(
            roomId,
            event.peer,
            event.packageId,
            event.revision,
            event.error,
          );
          return;
      }
    } catch (error) {
      // Observer failures are local bookkeeping problems, not runtime failures.
      this.logger.error(
        `Runtime observer failed for room ${roomId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
