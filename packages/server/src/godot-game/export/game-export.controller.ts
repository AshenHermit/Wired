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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { serveStaticAsset } from 'src/common/static-assets';
import { Public } from 'src/auth/auth-policy';

/** Route prefix, shared by the decorator and the path slice below. */
export const GAME_EXPORT_ROUTE = 'game-export';
const EXPORT_PREFIX = `/${GAME_EXPORT_ROUTE}`;

/**
 * Serves the generated Godot Web export from the backend so the iframe stays
 * same-origin with the app (the frontend proxies `/api/*` here). The export is
 * a build artifact: it is never committed and a missing build is an explicit
 * error, not an empty 200.
 *
 * Public: the iframe loads it before the game connects, and the files are the
 * same for every room.
 */
@Public()
@Controller(GAME_EXPORT_ROUTE)
export class GameExportController implements OnModuleInit {
  private readonly logger = new Logger(GameExportController.name);
  private readonly root: string;
  private readonly isProduction: boolean;

  constructor(configService: AppConfigService) {
    this.root = resolve(configService.godotRuntime.exportDir);
    this.isProduction = configService.isProduction;
  }

  onModuleInit(): void {
    if (!existsSync(this.root)) {
      // The export is a build artifact, so a fresh deploy can legitimately
      // lack it. Fail loudly at startup instead of only when a player opens
      // the Game tab.
      this.logger.warn(
        `Godot Web export is missing at ${this.root}; /${GAME_EXPORT_ROUTE} will return 404 until it is built`,
      );
    }
  }

  @Get()
  serveRoot(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    return this.servePath(req.path, req, res);
  }

  @Get('*path')
  serve(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    return this.servePath(req.path, req, res);
  }

  private servePath(
    urlPath: string,
    req: Request,
    res: Response,
  ): Promise<StreamableFile | undefined> {
    if (!existsSync(this.root)) {
      throw new NotFoundException(
        this.isProduction
          ? 'The game build is unavailable; contact the administrator'
          : 'Godot Web export is not built; run `pnpm export:game` before opening the Game tab',
      );
    }

    // Only the bare route and paths under it can address an export file. A
    // route rename would otherwise silently serve index.html for every asset.
    if (urlPath !== EXPORT_PREFIX && !urlPath.startsWith(`${EXPORT_PREFIX}/`)) {
      throw new NotFoundException('Game export file not found');
    }

    let relative: string;
    try {
      relative = decodeURIComponent(
        urlPath.slice(EXPORT_PREFIX.length).replace(/^\//, ''),
      );
    } catch {
      throw new BadRequestException('Malformed game export path');
    }

    return serveStaticAsset(this.root, relative, req, res, {
      revalidate: true,
      noStoreShell: true,
    });
  }
}
