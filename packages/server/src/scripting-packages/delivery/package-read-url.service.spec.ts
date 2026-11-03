import { ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { PackageReadUrlService } from './package-read-url.service';

const config = (secret: string, ttl = 900) =>
  ({ packages: { readSecret: secret, readTtlSec: ttl } }) as AppConfigService;

describe('PackageReadUrlService', () => {
  const subject = { roomId: 7, packageId: 42, revision: 3 };

  it('creates a token bound to room/package/revision and rejects expiry', () => {
    const service = new PackageReadUrlService(config('read-secret'));
    const { token, expiresAt } = service.createToken(subject, 1_000);
    expect(expiresAt).toBe(1_900);
    expect(service.verifyToken(token, subject, 1_899)).toBe(true);
    expect(service.verifyToken(token, subject, 1_900)).toBe(false);
  });

  it('rejects a token used for another room, package or revision', () => {
    const service = new PackageReadUrlService(config('read-secret'));
    const { token } = service.createToken(subject, 1_000);
    expect(service.verifyToken(token, { ...subject, roomId: 8 }, 1_001)).toBe(
      false,
    );
    expect(
      service.verifyToken(token, { ...subject, packageId: 43 }, 1_001),
    ).toBe(false);
    expect(service.verifyToken(token, { ...subject, revision: 4 }, 1_001)).toBe(
      false,
    );
  });

  it('rejects a tampered token', () => {
    const service = new PackageReadUrlService(config('read-secret'));
    const { token } = service.createToken(subject, 1_000);
    const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expect(service.verifyToken(tampered, subject, 1_001)).toBe(false);
  });

  it.each([
    ['exponent expiry', '1e3.' + 'a'.repeat(64)],
    ['extra dot', '1900.' + 'a'.repeat(64) + '.extra'],
    ['empty token', ''],
    ['empty mac', '1900.'],
    ['missing mac', '1900'],
  ])('rejects a malformed token: %s', (_name, malformed) => {
    const service = new PackageReadUrlService(config('read-secret'));
    expect(service.verifyToken(malformed, subject, 1_001)).toBe(false);
  });

  it('fails closed when the read secret is missing', () => {
    const service = new PackageReadUrlService(config(''));
    expect(() => service.createToken(subject, 1_000)).toThrow(
      ServiceUnavailableException,
    );
  });
});
