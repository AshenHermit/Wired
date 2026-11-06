import type { RoomRuntimeSession } from './room-runtime.session';
import { GodotRuntimeConfig } from './room-runtime.types';
import { RuntimeRecord } from './room-runtime.record';

const PORT_QUARANTINE_MS = 60_000;

/**
 * Single owner of the live runtime sessions and of the room port range.
 *
 * The service looks rooms up here instead of keeping a second map, so there is
 * exactly one place where a session exists: adding a room reserves its port,
 * and removing it (after a real exit) frees the slot.
 */
export class RoomRuntimeRegistry {
  private readonly activeByRoom = new Map<string, RoomRuntimeSession>();
  private readonly reservedPorts = new Map<number, RuntimeRecord>();
  private readonly unavailablePorts = new Map<number, number>();

  get(roomId: string): RoomRuntimeSession | undefined {
    return this.activeByRoom.get(roomId);
  }

  list(): RoomRuntimeSession[] {
    return [...this.activeByRoom.values()];
  }

  add(session: RoomRuntimeSession): void {
    this.activeByRoom.set(session.roomId, session);
    this.reservedPorts.set(session.port, session.record);
  }

  /** Forgets a room whose process is gone and whose port was released. */
  remove(roomId: string): void {
    const session = this.activeByRoom.get(roomId);
    if (!session) {
      return;
    }
    this.activeByRoom.delete(roomId);
    if (this.reservedPorts.get(session.port) === session.record) {
      this.reservedPorts.delete(session.port);
    }
  }

  allocatePort(config: GodotRuntimeConfig): number | null {
    const now = Date.now();
    for (let port = config.portStart; port <= config.portEnd; port += 1) {
      if (this.reservedPorts.has(port)) {
        continue;
      }
      const unavailableUntil = this.unavailablePorts.get(port);
      if (unavailableUntil !== undefined) {
        if (unavailableUntil > now) {
          continue;
        }
        this.unavailablePorts.delete(port);
      }
      return port;
    }
    return null;
  }

  markPortUnavailable(port: number): void {
    this.unavailablePorts.set(port, Date.now() + PORT_QUARANTINE_MS);
  }

  releasePort(record: RuntimeRecord): void {
    if (record.portReleased) {
      return;
    }
    record.portReleased = true;
    if (this.reservedPorts.get(record.port) === record) {
      this.reservedPorts.delete(record.port);
    }
  }
}
