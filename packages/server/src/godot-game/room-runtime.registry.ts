import { GodotRuntimeConfig } from './room-runtime.types';
import { RuntimeRecord } from './room-runtime.record';

const PORT_QUARANTINE_MS = 60_000;

export class RoomRuntimeRegistry {
  private readonly activeByRoom = new Map<string, RuntimeRecord>();
  private readonly reservedPorts = new Map<number, RuntimeRecord>();
  private readonly unavailablePorts = new Map<number, number>();

  get(roomId: string): RuntimeRecord | undefined {
    return this.activeByRoom.get(roomId);
  }

  list(): RuntimeRecord[] {
    return [...this.activeByRoom.values()];
  }

  add(record: RuntimeRecord): void {
    this.activeByRoom.set(record.roomId, record);
    this.reservedPorts.set(record.port, record);
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
