import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request, Response } from 'express';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
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
    await writeFile(path.join(workspace, 'secret.txt'), 'secret');
    await writeFile(path.join(projectPath, '_wired', 'extensionless'), 'x');
    await writeFile(
      path.join(workspace, 'editor', 'godot.editor.html'),
      '<!doctype html><title>editor</title>',
    );
    await writeFile(path.join(projectPath, '_wired', 'index.html'), '<p>x</p>');
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
        expect(response.headers['cache-control']).toBeUndefined();

        expect(response.body).toMatchObject({
          name: 'Wired',
          baseUrl: `/${GODOT_PROJECT_ROUTE}/`,
        });
        expect(response.body.filepaths).toContain('project.godot');

        await request(app.getHttpServer())
          .get(`/${GODOT_PROJECT_ROUTE}/project.godot`)
          .expect(200);
      } finally {
        await app.close();
      }
    });

    it('revalidates editor assets instead of re-downloading the 67 MB wasm', async () => {
      const app = await createApp();

      try {
        const first = await request(app.getHttpServer())
          .get('/godot-editor/engine.js')
          .expect(200);
        expect(first.headers['cache-control']).toBe('no-cache');
        expect(first.headers.etag).toBeDefined();

        await request(app.getHttpServer())
          .get('/godot-editor/engine.js')
          .set('If-None-Match', first.headers.etag)
          .expect(304);

        await request(app.getHttpServer())
          .get('/godot-editor/engine.js')
          .set('If-None-Match', `W/${first.headers.etag}, "stale"`)
          .expect(304);
      } finally {
        await app.close();
      }
    });

    it('keeps the standalone editor shell out of the cache', async () => {
      const app = await createApp();

      try {
        const response = await request(app.getHttpServer())
          .get('/godot-editor/godot.editor.html')
          .expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
      } finally {
        await app.close();
      }
    });

    it('revalidates base project files, including html payloads', async () => {
      const app = await createApp();

      try {
        for (const file of ['project.godot', 'index.html']) {
          const first = await request(app.getHttpServer())
            .get(`/${GODOT_PROJECT_ROUTE}/${file}`)
            .expect(200);
          expect(first.headers['cache-control']).toBe('no-cache');
          expect(first.headers.etag).toBeDefined();

          await request(app.getHttpServer())
            .get(`/${GODOT_PROJECT_ROUTE}/${file}`)
            .set('If-None-Match', first.headers.etag)
            .expect(304);
        }
      } finally {
        await app.close();
      }
    });
  });
});
