import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from 'src/config/config.module';
import { AppConfigService } from 'src/config/config.service';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { Room } from 'src/database/entities/room.entity';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageDeliveryController } from './package-delivery.controller';
import { ArtifactBuildRateLimiter } from './artifact-build.rate-limiter';
import { PackageStorageService } from '../storage/package-storage.service';
import { AssetBakeCache } from './asset-bake-cache';
import { AssetBakeService } from './asset-bake.service';
import { ChildProcessBakeRunner } from './godot-bake.runner';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([
      ScriptingPackage,
      ScriptingPackageRevision,
      Room,
    ]),
  ],
  providers: [
    PackageStorageService,
    PackageReadUrlService,
    {
      provide: AssetBakeCache,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new AssetBakeCache(
          config.assetBake.cacheDir,
          config.assetBake.cacheMaxBytes,
        ),
    },
    {
      provide: AssetBakeService,
      inject: [AppConfigService, AssetBakeCache],
      useFactory: (config: AppConfigService, cache: AssetBakeCache) =>
        new AssetBakeService(
          cache,
          new ChildProcessBakeRunner(config.assetBake.executablePath),
          {
            projectPath: config.assetBake.projectPath,
            executablePath: config.assetBake.executablePath,
            timeoutMs: config.assetBake.timeoutMs,
            maxConcurrency: config.assetBake.maxConcurrency,
          },
        ),
    },
    PackageDeliveryService,
    // Shared by the delivery controller so artifact builds are limited
    // process-wide instead of per hand-built instance.
    ArtifactBuildRateLimiter,
  ],
  controllers: [PackageDeliveryController],
  exports: [
    PackageStorageService,
    PackageReadUrlService,
    PackageDeliveryService,
  ],
})
export class PackageDeliveryModule {}
