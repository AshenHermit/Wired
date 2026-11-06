import {
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { WIRED_MEDIA_URL_PATTERN } from '@wired-io/shared';
import { AppConfigService } from 'src/config/config.service';
import { MAX_MEDIA_FILE_SIZE } from './media.constants';
import { MediaModule } from './media.module';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

describe('MediaController', () => {
  let app: INestApplication;
  let storageDir: string;

  const build = async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MediaModule],
      providers: [
        {
          // Mirror APP_GUARD: GET /media/:filename is public; POST requires auth.
          provide: APP_GUARD,
          useValue: {
            canActivate: (context: {
              switchToHttp: () => {
                getRequest: () => {
                  method: string;
                  headers: Record<string, string | undefined>;
                  user?: unknown;
                };
              };
            }) => {
              const req = context.switchToHttp().getRequest();
              if (req.method === 'GET') return true;
              if (!req.headers.authorization) {
                throw new UnauthorizedException();
              }
              req.user = { id: 1, email: 'author@wired.io' };
              return true;
            },
          },
        },
      ],
    })
      .overrideProvider(AppConfigService)
      .useValue({
        storage: {
          dir: storageDir,
          packagesFilesDir: join(storageDir, 'packages'),
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  beforeEach(async () => {
    storageDir = mkdtempSync(join(tmpdir(), 'wired-media-'));
    mkdirSync(join(storageDir, 'uploads'), { recursive: true });
    await build();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('uploads a PNG and returns a wired media URL', async () => {
    const response = await request(app.getHttpServer())
      .post('/media')
      .set('Authorization', 'Bearer test')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' })
      .expect(201);

    expect(response.body.url).toMatch(WIRED_MEDIA_URL_PATTERN);
    const filename = response.body.url.slice('/media/'.length);
    expect(existsSync(join(storageDir, 'uploads', filename))).toBe(true);
  });

  it('rejects unauthenticated uploads', async () => {
    await request(app.getHttpServer())
      .post('/media')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' })
      .expect(401);
  });

  it('rejects oversized uploads', async () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_FILE_SIZE)]);
    const response = await request(app.getHttpServer())
      .post('/media')
      .set('Authorization', 'Bearer test')
      .attach('file', oversized, {
        filename: 'big.png',
        contentType: 'image/png',
      });

    expect([400, 413]).toContain(response.status);
  });

  it('rejects non-image bytes with a spoofed Content-Type', async () => {
    await request(app.getHttpServer())
      .post('/media')
      .set('Authorization', 'Bearer test')
      .attach('file', Buffer.from('<!DOCTYPE html>'), {
        filename: 'evil.png',
        contentType: 'image/png',
      })
      .expect(400);
  });

  it('serves an existing image publicly', async () => {
    const filename = `${'a'.repeat(64)}.png`;
    writeFileSync(join(storageDir, 'uploads', filename), PNG);

    const response = await request(app.getHttpServer())
      .get(`/media/${filename}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.from(response.body as Buffer)).toEqual(PNG);
  });

  it('blocks path traversal on GET', async () => {
    writeFileSync(join(storageDir, 'secret.txt'), 'nope');
    const response = await request(app.getHttpServer()).get(
      `/media/${encodeURIComponent('../secret.txt')}`,
    );
    expect([400, 404]).toContain(response.status);
    expect(String(response.text ?? '')).not.toContain('nope');
  });
});
