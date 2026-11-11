import { PackageProgressPayload } from '@wired-io/shared';
import { PackageStreamService } from './package-stream.service';

/**
 * Next chunk of a stream, typed so the payload's fields stay checked.
 * Throws when the stream ends before the expected chunk arrives.
 */
const nextChunk = async (
  iterator: AsyncIterator<PackageProgressPayload>,
): Promise<PackageProgressPayload> => {
  const result = await iterator.next();
  if (result.done === true) {
    throw new Error('Stream ended before the expected chunk');
  }
  return result.value;
};

describe('PackageStreamService', () => {
  let service: PackageStreamService;

  beforeEach(() => {
    service = new PackageStreamService();
  });

  it('emits a first chunk with loadedBytes, totalBytes and status', async () => {
    const stream = service.openStream('pkg-1', 'Demo package', 1000);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await nextChunk(iterator);

    expect(first).toMatchObject({
      packageId: 'pkg-1',
      name: 'Demo package',
      loadedBytes: 0,
      totalBytes: 1000,
      status: 'loading',
    });
    expect(first.errorMessage).toBeUndefined();
  });

  it('reports progress as loadedBytes grow while status stays loading', async () => {
    const stream = service.openStream('pkg-2', 'Demo package', 1000);
    const iterator = stream[Symbol.asyncIterator]();
    await nextChunk(iterator); // first chunk (loading, 0 bytes)

    service.updateProgress('pkg-2', 250);
    const second = await nextChunk(iterator);

    expect(second).toMatchObject({
      packageId: 'pkg-2',
      name: 'Demo package',
      loadedBytes: 250,
      totalBytes: 1000,
      status: 'loading',
    });
  });

  it('marks a stream complete once all bytes are loaded', async () => {
    const stream = service.openStream('pkg-3', 'Demo package', 1000);
    const iterator = stream[Symbol.asyncIterator]();
    await nextChunk(iterator); // first chunk (loading, 0 bytes)

    service.completeStream('pkg-3');
    const last = await nextChunk(iterator);

    expect(last).toMatchObject({
      packageId: 'pkg-3',
      name: 'Demo package',
      loadedBytes: 1000,
      totalBytes: 1000,
      status: 'complete',
    });
    expect(last.errorMessage).toBeUndefined();
  });

  it('marks a stream failed with an error message', async () => {
    const stream = service.openStream('pkg-4', 'Demo package', 1000);
    const iterator = stream[Symbol.asyncIterator]();
    await nextChunk(iterator); // first chunk (loading, 0 bytes)

    service.failStream('pkg-4', 'hash mismatch');
    const last = await nextChunk(iterator);

    expect(last).toMatchObject({
      packageId: 'pkg-4',
      name: 'Demo package',
      loadedBytes: 0,
      totalBytes: 1000,
      status: 'error',
      errorMessage: 'hash mismatch',
    });
  });

  it('exposes the current progress of an open stream', () => {
    service.openStream('pkg-5', 'Demo package', 500);
    service.updateProgress('pkg-5', 125);

    const progress = service.progress('pkg-5');

    expect(progress).toMatchObject({
      packageId: 'pkg-5',
      name: 'Demo package',
      loadedBytes: 125,
      totalBytes: 500,
      status: 'loading',
    });
  });
});
