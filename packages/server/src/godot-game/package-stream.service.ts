import { Injectable, Logger } from '@nestjs/common';
import { PackageProgressPayload } from '@wired-io/shared';

/**
 * Mutable bookkeeping for one in-flight package stream, pushed to consumers as
 * progress chunks. The first chunk always reports `status: 'loading'` with
 * `loadedBytes: 0`; later chunks report byte progress, completion or failure.
 */
type PackageStreamState = {
  /** Last emitted payload, kept so `progress()` can snapshot it on demand. */
  payload: PackageProgressPayload;
  /** Chunks pushed but not yet consumed by the stream iterator. */
  queue: PackageProgressPayload[];
  /** Resumes a consumer that is waiting on the empty queue. */
  notify: () => void;
  /** A consumer is blocked waiting for the next chunk. */
  waiting: boolean;
  /** The stream reached a terminal state (`complete` or `error`). */
  finished: boolean;
};

/**
 * Tracks per-package delivery progress and exposes it as an async stream of
 * `PackageProgressPayload` chunks.
 *
 * Consumers open a stream with `openStream`, which yields an initial
 * `loading` chunk (`loadedBytes: 0`, declared `totalBytes`). Progress is
 * pushed with `updateProgress`, and the stream is terminated with
 * `completeStream` or `failStream`.
 *
 * The service is deliberately dependency-free: it owns no network protocol,
 * database access or runtime interaction. It only bookkeeps progress state so
 * callers (the editor bridge, a controller, or a scheduler) can report how
 * far a package transfer has gotten without inventing a new wire format.
 */
@Injectable()
export class PackageStreamService {
  private readonly logger = new Logger(PackageStreamService.name);
  private readonly streams = new Map<string, PackageStreamState>();

  /**
   * Opens a progress stream for one package and returns an async iterable of
   * `PackageProgressPayload` chunks.
   *
   * The first chunk reports `status: 'loading'`, `loadedBytes: 0` and the
   * declared `totalBytes`. Push later updates with `updateProgress`, or
   * terminate with `completeStream` / `failStream`. Only one stream may be
   * open per package id.
   */
  openStream(
    packageId: string,
    name: string,
    totalBytes: number,
  ): AsyncIterable<PackageProgressPayload> {
    if (this.streams.has(packageId)) {
      throw new Error(`A package stream is already open for ${packageId}`);
    }
    const payload: PackageProgressPayload = {
      packageId,
      name,
      loadedBytes: 0,
      totalBytes,
      status: 'loading',
    };
    const state: PackageStreamState = {
      payload,
      queue: [payload],
      waiting: false,
      finished: false,
      notify: () => undefined,
    };
    this.streams.set(packageId, state);

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<PackageProgressPayload> {
        while (true) {
          const chunk = state.queue.shift();
          if (chunk !== undefined) {
            // Drain every queued chunk before honoring the finished flag, so a
            // terminal chunk (complete/error) pushed while we were suspended
            // at a previous yield is still delivered to the consumer.
            yield chunk;
            continue;
          }
          // Queue drained: nothing more to deliver once the stream ended.
          if (state.finished) {
            return;
          }
          state.waiting = true;
          await new Promise<void>((resolve) => {
            state.notify = () => {
              state.waiting = false;
              resolve();
            };
          });
        }
      },
    };
  }

  /**
   * Pushes a progress update for an open stream. When `loadedBytes` reaches
   * (or exceeds) `totalBytes` the status flips to `complete` automatically;
   * call `completeStream` explicitly to terminate a finished transfer.
   */
  updateProgress(packageId: string, loadedBytes: number): void {
    const state = this.streams.get(packageId);
    if (!state || state.finished) {
      if (!state) {
        this.logger.warn(
          `No open package stream for ${packageId}; ignoring progress update`,
        );
      }
      return;
    }
    const status: PackageProgressPayload['status'] =
      loadedBytes >= state.payload.totalBytes ? 'complete' : 'loading';
    const chunk: PackageProgressPayload = {
      packageId: state.payload.packageId,
      name: state.payload.name,
      loadedBytes,
      totalBytes: state.payload.totalBytes,
      status,
      ...(state.payload.errorMessage !== undefined
        ? { errorMessage: state.payload.errorMessage }
        : {}),
    };
    state.payload = chunk;
    state.queue.push(chunk);
    state.notify();
  }

  /** Marks a stream complete: `loadedBytes` equals `totalBytes`, no error. */
  completeStream(packageId: string): void {
    const state = this.streams.get(packageId);
    if (!state || state.finished) {
      return;
    }
    const chunk: PackageProgressPayload = {
      packageId: state.payload.packageId,
      name: state.payload.name,
      loadedBytes: state.payload.totalBytes,
      totalBytes: state.payload.totalBytes,
      status: 'complete',
    };
    state.payload = chunk;
    state.queue.push(chunk);
    state.finished = true;
    state.notify();
  }

  /** Marks a stream failed with `errorMessage` and terminates it. */
  failStream(packageId: string, errorMessage: string): void {
    const state = this.streams.get(packageId);
    if (!state || state.finished) {
      return;
    }
    const chunk: PackageProgressPayload = {
      packageId: state.payload.packageId,
      name: state.payload.name,
      loadedBytes: state.payload.loadedBytes,
      totalBytes: state.payload.totalBytes,
      status: 'error',
      errorMessage,
    };
    state.payload = chunk;
    state.queue.push(chunk);
    state.finished = true;
    state.notify();
  }

  /** Current progress of an open stream, or `undefined` when none is open. */
  progress(packageId: string): PackageProgressPayload | undefined {
    return this.streams.get(packageId)?.payload;
  }
}
