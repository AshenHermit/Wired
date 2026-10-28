import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppConfigService } from 'src/config/config.service';
import { GameExportController } from './game-export.controller';

describe('GameExportController', () => {
  let app: INestApplication;
  let projectDir: string;
  let webDir: string;

  const build = async () => {
    const configService = {
      godotRuntime: { projectPath: projectDir },
      isProduction: false,
    } as unknown as AppConfigService;
    const moduleRef = await Test.createTestingModule({
      controllers: [GameExportController],
      providers: [{ provide: AppConfigService, useValue: configService }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'wired-export-'));
    webDir = join(projectDir, 'build', 'web');
    mkdirSync(join(webDir, 'worklets'), { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>game</title>');
    writeFileSync(join(webDir, 'index.js'), 'console.log("engine");');
    writeFileSync(join(webDir, 'index.wasm'), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(webDir, 'index.pck'), Buffer.from([1, 2, 3]));
    writeFileSync(join(webDir, 'worklets', 'audio.worklet.js'), '// worklet');
    writeFileSync(join(projectDir, 'secret.txt'), 'must not be served');
    await build();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('serves the shell and WASM with the MIME types browsers require', async () => {
    const html = await request(app.getHttpServer())
      .get('/game-export/index.html')
      .expect(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.text).toContain('<title>game</title>');

    const wasm = await request(app.getHttpServer())
      .get('/game-export/index.wasm')
      .expect(200);
    expect(wasm.headers['content-type']).toMatch(/^application\/wasm/);

    const pck = await request(app.getHttpServer())
      .get('/game-export/index.pck')
      .expect(200);
    expect(pck.headers['content-type']).toMatch(/^application\/octet-stream/);

    const script = await request(app.getHttpServer())
      .get('/game-export/index.js')
      .expect(200);
    expect(script.headers['content-type']).toMatch(/^text\/javascript/);

    const worklet = await request(app.getHttpServer())
      .get('/game-export/worklets/audio.worklet.js')
      .expect(200);
    expect(worklet.headers['content-type']).toMatch(/^text\/javascript/);
  });

  it('sets the cross-origin isolation headers and never caches a generated build', async () => {
    const response = await request(app.getHttpServer())
      .get('/game-export/index.html')
      .expect(200);

    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-length']).toBeDefined();
  });

  it('revalidates engine assets instead of forcing a 36 MB re-download', async () => {
    const first = await request(app.getHttpServer())
      .get('/game-export/index.wasm')
      .expect(200);
    expect(first.headers['cache-control']).toBe('no-cache');
    expect(first.headers.etag).toBeDefined();

    await request(app.getHttpServer())
      .get('/game-export/index.wasm')
      .set('If-None-Match', first.headers.etag)
      .expect(304);

    const shell = await request(app.getHttpServer())
      .get('/game-export/index.html')
      .expect(200);
    expect(shell.headers['cache-control']).toBe('no-store');
  });

  it('serves index.html at the export root', async () => {
    const response = await request(app.getHttpServer())
      .get('/game-export/')
      .expect(200);

    expect(response.text).toContain('<title>game</title>');
  });

  it('refuses to escape the export directory', async () => {
    await request(app.getHttpServer())
      .get('/game-export/%2e%2e%2fsecret.txt')
      .expect(404);
    await request(app.getHttpServer())
      .get('/game-export/..%5csecret.txt')
      .expect(404);
  });

  it('reports a missing file and a missing build explicitly', async () => {
    const missing = await request(app.getHttpServer())
      .get('/game-export/nope.wasm')
      .expect(404);
    expect(missing.body.message).toMatch(/not found/i);

    rmSync(join(projectDir, 'build'), { recursive: true, force: true });
    const unbuilt = await request(app.getHttpServer())
      .get('/game-export/index.html')
      .expect(404);
    expect(unbuilt.body.message).toMatch(/export:game|not built/i);
  });
});
