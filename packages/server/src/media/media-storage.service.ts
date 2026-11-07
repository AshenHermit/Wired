import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { MAX_MEDIA_FILE_SIZE } from './media.constants';
import { detectImageKind } from './media-image';

@Injectable()
export class MediaStorageService {
  constructor(private readonly config: AppConfigService) {}

  get uploadsRoot(): string {
    return join(this.config.storage.dir, 'uploads');
  }

  async saveImage(buffer: Buffer): Promise<{ url: string; filename: string }> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Image file body is required');
    }
    if (buffer.length > MAX_MEDIA_FILE_SIZE) {
      throw new BadRequestException('Image exceeds the 2 MiB limit');
    }

    const kind = detectImageKind(buffer);
    if (!kind) {
      throw new BadRequestException(
        'Only PNG, JPEG, and WEBP images are accepted',
      );
    }

    const filename = `${randomBytes(32).toString('hex')}.${kind.ext}`;
    await mkdir(this.uploadsRoot, { recursive: true });
    await writeFile(join(this.uploadsRoot, filename), buffer);

    return { url: `/media/${filename}`, filename };
  }
}
