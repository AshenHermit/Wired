import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from 'src/config/config.module';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageStorageService } from './package-storage.service';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([ScriptingPackage, ScriptingPackageRevision]),
  ],
  providers: [
    PackageStorageService,
    PackageReadUrlService,
    PackageDeliveryService,
  ],
  exports: [
    PackageStorageService,
    PackageReadUrlService,
    PackageDeliveryService,
  ],
})
export class PackageDeliveryModule {}
