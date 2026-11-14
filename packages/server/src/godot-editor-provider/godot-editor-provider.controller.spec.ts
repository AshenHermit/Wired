import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request, Response } from 'express';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { brotliCompressSync } from 'node:zlib';
import request from 'supertest';
import { GODOT_PROJECT_ROUTE } from '@wired-io/shared';
import { AppConfigService } from 'src/config/config.service';
import { GodotEditorProviderController } from './godot-editor-provider.controller';

function fakeRequest(): Request {
  return { path: '/', headers: {} } as unknown as Request;
}

function fakeResponse(): Response {
  const res = { set: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

describe('GodotEditorProviderController', () => {
  let workspace: string;
  let projectPath: string;
  let controller: GodotEditorProviderController;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'wired-editor-'));
    projectPath = path.join(workspace, 'project');
    await mkdir(path.join(projectPath, '_wired'), { recursive: true });
    await mkdir(path.join(workspace, 'editor'), { recursive: true });
    await writeFile(
      path.join(projectPath, '_wired', 'project.godot'),
      'config_version=5',
    );
    await writeFile(
      path.join(workspace, 'editor', 'engine.js'),
      'console.log(1)',
    );
    const bigPayload = Buffer.from('x'.repeat(4096));
    await writeFile(path.join(workspace, 'editor', 'big.js'), bigPayload);
    await writeFile(
      path.join(workspace, 'editor', 'big.js.br'),
      brotliCompressSync(bigPayload),
    );
    await writeFile(path.join(workspace, 'secret.txt'), 'secret');
    await writeFile(path.join(projectPath, '_wired', 'extensionless'), 'x');
  });

  beforeEach(() => {
    controller = new GodotEditorProviderController({
      godot: {
        editorPath: path.relative(
          process.cwd(),
          path.join(workspace, 'editor'),
        ),
        projectPath: path.relative(process.cwd(), projectPath),
      },
    } as never);
  });

  it('serves a file inside the editor directory', async () => {
    const file = await controller.getEditorFile(
      'engine.js',
      fakeRequest(),
      fakeResponse(),
    );
    expect(file).toBeDefined();
  });

  it.each(['../../secret.txt', '..%2F..%2Fsecret.txt', '/etc/passwd', ''])(
    'rejects an unsafe editor path: %p',
    async (unsafePath) => {
      await expect(
        controller.getEditorFile(unsafePath, fakeRequest(), fakeResponse()),
      ).rejects.toThrow();
    },
  );

  it('serves a file inside the base project', async () => {
    const file = await controller.getGodotProjectFile(
      'project.godot',
      fakeRequest(),
      fakeResponse(),
    );
    expect(file).toBeDefined();
  });

  it('rejects traversal outside the base project', async () => {
    await expect(
      controller.getGodotProjectFile(
        '../../secret.txt',
        fakeRequest(),
        fakeResponse(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 for a missing project file', async () => {
    await expect(
      controller.getGodotProjectFile(
        'missing.godot',
        fakeRequest(),
        fakeResponse(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists extensionless files in the base project', async () => {
    const info = await controller.getGodotProjectInfo();
    expect(info.filepaths).toContain('extensionless');
  });

  describe('HTTP wildcard routing', () => {
    async function createApp() {
      const moduleRef = await Test.createTestingModule({
        controllers: [GodotEditorProviderController],
        providers: [
          {
            provide: AppConfigService,
            useValue: {
              godot: {
                editorPath: path.relative(
                  process.cwd(),
                  path.join(workspace, 'editor'),
                ),
                projectPath: path.relative(process.cwd(), projectPath),
              },
            },
          },
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      return app;
    }

    it('binds the wildcard path parameter and serves the editor asset', async () => {
      const app = await createApp();

      try {
        await request(app.getHttpServer())
          .get('/godot-editor/engine.js')
          .expect(200)
          .expect('console.log(1)');

        await request(app.getHttpServer())
          .get('/godot-editor/..%2F..%2Fsecret.txt')
          .expect(400);
      } finally {
        await app.close();
      }
    });

    // The client asks for this path by name, so the route is a cross-tier
    // contract: if it moves, the editor reports a start failure instead of a
    // missing manifest.
    it('serves the project manifest from the shared route', async () => {
      const app = await createApp();

      try {
        const response = await request(app.getHttpServer())
          .get(`/${GODOT_PROJECT_ROUTE}`)
          .expect(200);

        expect(response.body).toMatchObject({
          name: 'Wired',
          baseUrl: `/${GODOT_PROJECT_ROUTE}/`,
        });
        expect((response.body as { filepaths: string[] }).filepaths).toContain(
          'project.godot',
        );

        await request(app.getHttpServer())
          .get(`/${GODOT_PROJECT_ROUTE}/project.godot`)
          .expect(200);
      } finally {
        await app.close();
      }
    });

    it('serves a precompressed sidecar to brotli clients', async () => {
      const app = await createApp();
      try {
        const response = await request(app.getHttpServer())
          .get('/godot-editor/big.js')
          .set('Accept-Encoding', 'br')
          .expect(200);
        expect(response.headers['content-encoding']).toBe('br');
        expect(response.headers['vary']).toContain('Accept-Encoding');
      } finally {
        await app.close();
      }
    });

    it('revalidates the editor file with an ETag', async () => {
      const app = await createApp();
      try {
        const first = await request(app.getHttpServer())
          .get('/godot-editor/big.js')
          .expect(200);
        expect(first.headers.etag).toBeDefined();
        await request(app.getHttpServer())
          .get('/godot-editor/big.js')
          .set('If-None-Match', first.headers.etag)
          .expect(304);
      } finally {
        await app.close();
      }
    });
  });
});
