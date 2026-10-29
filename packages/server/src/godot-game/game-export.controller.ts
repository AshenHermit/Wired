import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  OnModuleInit,
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
export class GameExportController implements OnModuleInit {
  private readonly logger = new Logger(GameExportController.name);
  private readonly root: string;
  private readonly isProduction: boolean;

  constructor(configService: AppConfigService) {
    this.root = resolve(process.cwd(), configService.godotRuntime.exportDir);
    this.isProduction = configService.isProduction;
  }

  onModuleInit(): void {
    if (!existsSync(this.root)) {
      // The export is a build artifact, so a fresh deploy can legitimately
      // lack it. Fail loudly at startup instead of only when a player opens
      // the Game tab.
      this.logger.warn(
        `Godot Web export is missing at ${this.root}; /game-export will return 404 until it is built`,
      );
    }
  }

  @Get()
  serveRoot(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile | undefined {
    return this.servePath(req.path, req, res);
  }

  @Get('*path')
  serve(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile | undefined {
    return this.servePath(req.path, req, res);
  }

  private servePath(
    urlPath: string,
    req: Request,
    res: Response,
  ): StreamableFile | undefined {
    if (!existsSync(this.root)) {
      throw new NotFoundException(
        this.isProduction
          ? 'The game build is unavailable; contact the administrator'
          : 'Godot Web export is not built; run `pnpm export:game` before opening the Game tab',
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

    const extension = extname(target).toLowerCase();
    // Revalidate export assets instead of re-downloading the ~36 MB engine on
    // every reconnect. The shell itself stays uncached so a new export is
    // picked up immediately.
    const isShell = extension === '.html' || extension === '.htm';
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.set({
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Cache-Control': isShell ? 'no-store' : 'no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // The iframe and the app share an origin, but keep the export isolated
      // from embedding elsewhere.
      'Cross-Origin-Resource-Policy': 'same-origin',
    });

    if (req.headers['if-none-match'] === etag) {
      res.status(304);
      return undefined;
    }

    res.set('Content-Length', String(stat.size));
    return new StreamableFile(createReadStream(target), {
      length: stat.size,
    });
  }
}
