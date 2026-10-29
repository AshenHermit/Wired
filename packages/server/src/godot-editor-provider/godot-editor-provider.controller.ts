import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ProjectInfo } from '@wired-io/shared';
import { Extension, getContentType } from 'content-type-to-ext';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { glob, stat } from 'fs/promises';
import path, { resolve } from 'path';
import { AppConfigService } from 'src/config/config.service';
import { resolvePackagePath } from 'src/scripting-packages/package-path';

const EXCLUDED_PROJECT_DIRS = new Set(['build', 'storage', '.godot']);

/**
 * Express gives wildcard params either as a string or as an array of segments
 * depending on the router version, so both forms are normalized here.
 */
function toRelativePath(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value : [value ?? '']).join('/');
}

async function assertFile(fullPath: string): Promise<string> {
  const info = await stat(fullPath).catch(() => null);
  if (!info?.isFile()) {
    throw new NotFoundException('File not found');
  }
  return fullPath;
}

@Controller('')
export class GodotEditorProviderController {
  constructor(private readonly configService: AppConfigService) {}

  @Get('godot-editor/*path')
  async getFiles(
    @Param('path') requestedPath: string | string[],
    @Res({ passthrough: true }) res?: Response,
  ): Promise<StreamableFile> {
    const relativeFilepath = toRelativePath(requestedPath);
    const file = await assertFile(
      resolvePackagePath(
        resolve(this.configService.godot.editorPath),
        relativeFilepath,
      ),
    );
    res?.set({
      'Content-Type': getContentType(
        path.extname(relativeFilepath).substring(1) as Extension,
      ),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    return new StreamableFile(createReadStream(file));
  }
  @Get('godot-project-info/wired')
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
      baseUrl: '/godot-project/wired/',
      filepaths: filepaths,
    };
    return projectInfo;
  }
  @Get('godot-project/wired/*filepath')
  async getGodotProjectFile(
    @Param('filepath') filepath: string | string[],
    @Res({ passthrough: true }) res?: Response,
  ): Promise<StreamableFile> {
    const projectDir = path.join(
      resolve(this.configService.godot.projectPath),
      '_wired',
    );
    const file = await assertFile(
      resolvePackagePath(projectDir, toRelativePath(filepath)),
    );
    res?.set({
      'Content-Type': 'application/octet-stream',
    });
    return new StreamableFile(createReadStream(file));
  }
}
