import { RoomRuntimeRegistry } from './room-runtime.registry';
import { RoomRuntimeSession } from './room-runtime.session';
import { GodotRuntimeConfig } from './room-runtime.types';

const config: GodotRuntimeConfig = {
  executablePath: 'C:/godot/godot.console.exe',
  projectPath: 'C:/wired/godot_project/_wired',
  portStart: 19200,
  portEnd: 19202,
  bindAddress: '127.0.0.1',
  idleTimeoutMs: 60_000,
  shutdownGraceMs: 5_000,
  startTimeoutMs: 10_000,
  ticketTtlSec: 60,
  ticketSecret: 'test-secret',
  ticketRateLimit: 20,
  ticketRateLimitWindowMs: 60_000,
  stateSaveIntervalMs: 30_000,
  apiUrl: 'http://127.0.0.1:3000',
  stateDir: 'C:/wired/storage/rooms',
  exportDir: 'C:/wired/game_export/web',
  publicWsBaseUrl: '',
  wsMaxClientsPerRoom: 32,
  wsMaxTotal: 512,
  logBufferLines: 50,
};

/** The registry only reads roomId, port and record from a session. */
const fakeSession = (roomId: string, port: number) => {
  const record = { roomId, port, portReleased: false };
  return { roomId, port, record } as unknown as RoomRuntimeSession;
};

describe('RoomRuntimeRegistry', () => {
  let registry: RoomRuntimeRegistry;

  beforeEach(() => {
    registry = new RoomRuntimeRegistry();
  });

  it('returns the session of a room and lists every tracked session', () => {
    const first = fakeSession('room-1', 19200);
    const second = fakeSession('room-2', 19201);

    registry.add(first);
    registry.add(second);

    expect(registry.get('room-1')).toBe(first);
    expect(registry.get('room-3')).toBeUndefined();
    expect(registry.list()).toEqual([first, second]);
  });

  it('allocates the lowest free port and skips reserved ones', () => {
    expect(registry.allocatePort(config)).toBe(19200);
    registry.add(fakeSession('room-1', 19200));

    expect(registry.allocatePort(config)).toBe(19201);
    registry.add(fakeSession('room-2', 19201));
    registry.add(fakeSession('room-3', 19202));

    expect(registry.allocatePort(config)).toBeNull();
  });

  it('quarantines a port that failed to bind and later frees it again', () => {
    jest.useFakeTimers();
    registry.markPortUnavailable(19200);

    expect(registry.allocatePort(config)).toBe(19201);

    jest.advanceTimersByTime(60_000);
    expect(registry.allocatePort(config)).toBe(19200);
    jest.useRealTimers();
  });

  it('releases a port once and ignores a release by another record', () => {
    const session = fakeSession('room-1', 19200);
    registry.add(session);

    registry.releasePort(session.record);
    registry.releasePort(session.record);

    expect(session.record.portReleased).toBe(true);
    expect(registry.allocatePort(config)).toBe(19200);

    const other = fakeSession('room-2', 19200);
    registry.add(other);
    registry.releasePort(session.record);
    expect(registry.allocatePort(config)).toBe(19201);
  });

  it('forgets a removed room', () => {
    registry.add(fakeSession('room-1', 19200));

    registry.remove('room-1');

    expect(registry.get('room-1')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});
