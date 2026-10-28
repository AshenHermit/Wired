import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { AppConfigService } from 'src/config/config.service';

const EXPORT_PREFIX = '/game-export/';
const DEFAULT_FILE = 'index.html';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves the generated Godot Web export from the backend so the iframe stays
 * same-origin with the app (the frontend proxies `/api/*` here). The export is
 * a build artifact: it is never committed and a missing build is an explicit
 * error, not an empty 200.
 */
@Controller('game-export')
export class GameExportController {
  private readonly root: string;

  constructor(configService: AppConfigService) {
    this.root = resolve(
      process.cwd(),
      configService.godotRuntime.projectPath,
      'build',
      'web',
    );
  }

  @Get()
  serveRoot(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    return this.servePath(req.path, res);
  }

  @Get('*path')
  serve(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    return this.servePath(req.path, res);
  }

  private servePath(urlPath: string, res: Response): StreamableFile {
    if (!existsSync(this.root)) {
      throw new NotFoundException(
        'Godot Web export is not built; run `pnpm export:game` before opening the Game tab',
      );
    }

    let relative: string;
    try {
      relative = decodeURIComponent(
        urlPath.startsWith(EXPORT_PREFIX)
          ? urlPath.slice(EXPORT_PREFIX.length)
          : '',
      );
    } catch {
      throw new BadRequestException('Malformed game export path');
    }
    if (relative.includes('\0')) {
      throw new BadRequestException('Malformed game export path');
    }
    if (!relative || relative.endsWith('/')) {
      relative += DEFAULT_FILE;
    }

    const target = resolve(this.root, relative);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new NotFoundException('Game export file not found');
    }

    let stat;
    try {
      stat = statSync(target);
    } catch {
      throw new NotFoundException('Game export file not found');
    }
    if (!stat.isFile()) {
      throw new NotFoundException('Game export file not found');
    }

    res.set({
      'Content-Type':
        CONTENT_TYPES[extname(target).toLowerCase()] ??
        'application/octet-stream',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // The iframe and the app share an origin, but keep the export isolated
      // from embedding elsewhere.
      'Cross-Origin-Resource-Policy': 'same-origin',
    });

    return new StreamableFile(createReadStream(target), {
      length: stat.size,
    });
  }
}
