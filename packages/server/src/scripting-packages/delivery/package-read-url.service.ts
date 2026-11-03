import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';

export type PackageReadSubject = {
  roomId: number;
  packageId: number;
  revision: number;
};

/**
 * Signs short-lived read URLs for package files. A token is bound to one room,
 * package and revision, so a leaked token cannot be reused for other packages.
 */
@Injectable()
export class PackageReadUrlService {
  constructor(private readonly configService: AppConfigService) {}

  createToken(
    subject: PackageReadSubject,
    nowSec = Math.floor(Date.now() / 1000),
  ): { token: string; expiresAt: number } {
    const { readSecret, readTtlSec } = this.configService.packages;
    if (!readSecret) {
      throw new ServiceUnavailableException('package_read_secret_missing');
    }

    const expiresAt = nowSec + readTtlSec;
    return {
      token: `${expiresAt}.${this.sign(readSecret, subject, expiresAt)}`,
      expiresAt,
    };
  }

  verifyToken(
    token: string,
    subject: PackageReadSubject,
    nowSec = Math.floor(Date.now() / 1000),
  ): boolean {
    try {
      const { readSecret } = this.configService.packages;
      const [expiresRaw, mac, extra] = token.split('.');
      if (
        !readSecret ||
        extra !== undefined ||
        !mac ||
        !/^\d+$/.test(expiresRaw)
      ) {
        return false;
      }

      const expiresAt = Number(expiresRaw);
      if (!(expiresAt > nowSec)) {
        return false;
      }

      const expected = Buffer.from(this.sign(readSecret, subject, expiresAt));
      const actual = Buffer.from(mac);
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    } catch {
      return false;
    }
  }

  private sign(
    secret: string,
    subject: PackageReadSubject,
    expiresAt: number,
  ): string {
    const message = `package-read:v1:${subject.roomId}:${subject.packageId}:${subject.revision}:${expiresAt}`;
    return createHmac('sha256', secret).update(message).digest('hex');
  }
}
