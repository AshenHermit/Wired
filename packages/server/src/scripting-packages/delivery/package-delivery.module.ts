import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from 'src/config/config.module';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { Room } from 'src/database/entities/room.entity';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageDeliveryController } from './package-delivery.controller';
import { ArtifactBuildRateLimiter } from './artifact-build.rate-limiter';
import { PackageStorageService } from '../storage/package-storage.service';

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
