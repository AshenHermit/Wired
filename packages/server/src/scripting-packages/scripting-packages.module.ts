import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { ScriptingPackagesController } from './scripting-packages.controller';
import { PackageRevisionsService } from './package-revisions.service';
import { PackageStorageService } from './package-storage.service';
import { AppConfigModule } from 'src/config/config.module';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([
      ScriptingPackage,
      ScriptingPackageRevision,
      User,
      Room,
    ]),
  ],
  providers: [
    ScriptingPackagesService,
    PackageStorageService,
    PackageRevisionsService,
  ],
  controllers: [ScriptingPackagesController],
  exports: [ScriptingPackagesService, PackageRevisionsService],
})
export class ScriptingPackagesModule {}
