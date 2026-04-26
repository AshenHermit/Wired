import {
  Controller,
  Get,
  Module,
  Param,
  ParseArrayPipe,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ProjectInfo } from '@wired-io/shared';
import { Extension, getContentType } from 'content-type-to-ext';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { glob } from 'fs/promises';
import path, { join } from 'path';
import { AppConfigService } from 'src/config/config.service';

@Controller('')
export class GodotEditorProviderController {
  constructor(private readonly configService: AppConfigService) {}

  @Get('godot-editor/*path')
  getFiles(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const relativeFilepath = req.url.split('/godot-editor/')[1];
    const file = createReadStream(
      join(
        process.cwd(),
        this.configService.godot.editorPath,
        relativeFilepath,
      ),
    );
    res.set({
      'Content-Type': getContentType(
        path.extname(relativeFilepath).substring(1) as Extension,
      ),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    return new StreamableFile(file);
  }
  @Get('godot-project-info/wired')
  async getGodotProjectZip(): Promise<ProjectInfo> {
    const projectDir = path.join(
      process.cwd(),
      this.configService.godot.projectPath,
      '_wired',
    );
    const filepaths: string[] = [];
    for await (const filepath of glob(path.join(projectDir, '**', '*.*'))) {
      filepaths.push(path.relative(projectDir, filepath).replace(/\\/g, '/'));
    }
    const projectInfo: ProjectInfo = {
      name: 'Wired',
      baseUrl: '/godot-project/wired/',
      filepaths: filepaths,
    };
    return projectInfo;
  }
  @Get('godot-project/wired/*filepath')
  getGodotProjectFile(
    @Param('filepath', ParseArrayPipe) filepath: string[],
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    const projectDir = path.join(
      process.cwd(),
      this.configService.godot.projectPath,
      '_wired',
    );
    const file = createReadStream(path.join(projectDir, filepath.join('/')));
    res.set({
      'Content-Type': 'application/octet-stream',
    });
    return new StreamableFile(file);
  }
}
