import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { AppConfigService } from 'src/config/config.service';
import { GodotEditorProviderController } from './godot-editor-provider.controller';

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
    const file = await controller.getFiles('engine.js');
    expect(file).toBeDefined();
  });

  it.each(['../../secret.txt', '..%2F..%2Fsecret.txt', '/etc/passwd', ''])(
    'rejects an unsafe editor path: %p',
    async (unsafePath) => {
      await expect(controller.getFiles(unsafePath)).rejects.toThrow();
    },
  );

  it('serves a file inside the base project', async () => {
    const file = await controller.getGodotProjectFile('project.godot');
    expect(file).toBeDefined();
  });

  it('rejects traversal outside the base project', async () => {
    await expect(
      controller.getGodotProjectFile('../../secret.txt'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 for a missing project file', async () => {
    await expect(
      controller.getGodotProjectFile('missing.godot'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('HTTP wildcard routing', () => {
    it('binds the wildcard path parameter and serves the editor asset', async () => {
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
  });
});
