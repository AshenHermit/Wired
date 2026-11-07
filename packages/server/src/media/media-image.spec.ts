import { detectImageKind } from './media-image';

/** Minimal PNG signature (8 bytes). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal JPEG SOI + APP0 marker. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** RIFF....WEBP header. */
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('detectImageKind', () => {
  it('detects PNG', () => {
    expect(detectImageKind(PNG)).toEqual({
      mime: 'image/png',
      ext: 'png',
    });
  });

  it('detects JPEG', () => {
    expect(detectImageKind(JPEG)).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('detects WEBP', () => {
    expect(detectImageKind(WEBP)).toEqual({
      mime: 'image/webp',
      ext: 'webp',
    });
  });

  it('rejects an empty buffer', () => {
    expect(detectImageKind(Buffer.alloc(0))).toBeNull();
  });

  it('rejects random bytes', () => {
    expect(detectImageKind(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('rejects HTML masquerading as an image', () => {
    expect(detectImageKind(Buffer.from('<!DOCTYPE html><html></html>'))).toBeNull();
  });
});
