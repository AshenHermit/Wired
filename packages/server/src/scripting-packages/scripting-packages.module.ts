import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { RetiredPackageSlug } from 'src/database/entities/retired-package-slug.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { ScriptingPackagesController } from './scripting-packages.controller';
import { PackageRevisionsService } from './package-revisions.service';
import { PackageWorkshopService } from './package-workshop.service';
import { PackageDeliveryModule } from './package-delivery.module';
import { AppConfigModule } from 'src/config/config.module';
import { GodotGameModule } from 'src/godot-game/godot-game.module';

@Module({
  imports: [
    AppConfigModule,
    GodotGameModule,
    PackageDeliveryModule,
    TypeOrmModule.forFeature([
      ScriptingPackage,
      ScriptingPackageRevision,
      RetiredPackageSlug,
      User,
      Room,
    ]),
  ],
  providers: [
    ScriptingPackagesService,
    PackageRevisionsService,
    PackageWorkshopService,
  ],
  controllers: [ScriptingPackagesController],
  exports: [ScriptingPackagesService, PackageRevisionsService],
})
export class ScriptingPackagesModule {}
