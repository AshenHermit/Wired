import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { GODOT_PROJECT_ROUTE, ProjectInfo } from '@wired-io/shared';
import { Request, Response } from 'express';
import { glob, stat } from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { serveStaticAsset, wildcardPath } from 'src/common/static-assets';
import { Public } from 'src/auth/auth-policy';

const EXCLUDED_PROJECT_DIRS = new Set(['build', 'storage', '.godot']);

/**
 * Serves the WASM editor's own assets and the shared base project.
 *
 * Public on purpose: the editor bootstraps before it knows who the user is,
 * and the files are the same for every room.
 */
@Public()
@Controller('')
export class GodotEditorProviderController {
  constructor(private readonly configService: AppConfigService) {}

  @Get('godot-editor/*path')
  getEditorFile(
    @Param('path') requestedPath: string | string[],
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    return serveStaticAsset(
      resolve(this.configService.godot.editorPath),
      wildcardPath(requestedPath),
      req,
      res,
      {
        // Browsers decompress brotli themselves and Godot's runtime never
        // reads these files, so sidecars are safe here and only here.
        precompressed: true,
        // The editor tree is ~40 MB; revalidate instead of re-downloading.
        revalidate: true,
        noStoreShell: true,
      },
    );
  }

  @Get(GODOT_PROJECT_ROUTE)
  async getGodotProjectInfo(): Promise<ProjectInfo> {
    const projectDir = path.join(
      resolve(this.configService.godot.projectPath),
      '_wired',
    );
    const filepaths: string[] = [];
    for await (const filepath of glob(path.join(projectDir, '**', '*'))) {
      let isFile = false;
      try {
        isFile = (await stat(filepath)).isFile();
      } catch {
        continue;
      }
      if (!isFile) {
        continue;
      }
      const relative = path.relative(projectDir, filepath).replace(/\\/g, '/');
      // The export and runtime state must never reach the editor FS, even if
      // somebody builds into the base project by mistake.
      if (
        relative
          .split('/')
          .some((segment) => EXCLUDED_PROJECT_DIRS.has(segment))
      ) {
        continue;
      }
      filepaths.push(relative);
    }
    const projectInfo: ProjectInfo = {
      name: 'Wired',
      baseUrl: `/${GODOT_PROJECT_ROUTE}/`,
      filepaths: filepaths,
    };
    return projectInfo;
  }

  @Get(`${GODOT_PROJECT_ROUTE}/*filepath`)
  getGodotProjectFile(
    @Param('filepath') filepath: string | string[],
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    return serveStaticAsset(
      path.join(resolve(this.configService.godot.projectPath), '_wired'),
      wildcardPath(filepath),
      req,
      res,
      {
        // The editor writes these into its own file system, so the browser
        // never has to interpret them.
        contentType: () => 'application/octet-stream',
        // Not document responses: isolation headers would only add noise.
        crossOriginIsolation: false,
        // There is no shell in the project tree: every file is a payload the
        // editor FS fetches, so revalidate — never no-store.
        revalidate: true,
      },
    );
  }
}
