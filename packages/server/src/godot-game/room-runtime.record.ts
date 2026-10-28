import { RoomRuntimeLog } from './room-runtime.log';
import { RoomRuntimeState, RuntimeProcess } from './room-runtime.types';

export interface RuntimeRecord {
  key: string;
  roomId: string;
  port: number;
  state: RoomRuntimeState;
  process: RuntimeProcess | null;
  pid: number | null;
  log: RoomRuntimeLog;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  error: string | null;
  activePlayers: number;
  authenticatedPeers: Set<number>;
  /** Epoch ms until which a peerless runtime waits for a first handshake. */
  handshakeLeaseUntil: number;
  stopRequested: boolean;
  forceKilled: boolean;
  readySettled: boolean;
  exitHandled: boolean;
  portReleased: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  startTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  stopPromise?: Promise<void>;
}
