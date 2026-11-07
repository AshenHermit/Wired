import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { ScriptingPackagesController } from './scripting-packages.controller';
import { PackageRevisionsService } from './publish/package-revisions.service';
import { PackageWorkshopService } from './workshop/package-workshop.service';
import { WorkshopController } from './workshop/workshop.controller';
import { PackagePublishLockService } from './publish/package-publish-lock.service';
import { PackageDeliveryModule } from './delivery/package-delivery.module';
import { AppConfigModule } from 'src/config/config.module';
import { GodotGameModule } from 'src/godot-game/godot-game.module';
import { UsersService } from 'src/users/users.service';

@Module({
  imports: [
    AppConfigModule,
    // Cycle: RoomsModule → ScriptingPackagesModule → GodotGameModule → RoomsModule.
    forwardRef(() => GodotGameModule),
    PackageDeliveryModule,
    TypeOrmModule.forFeature([
      ScriptingPackage,
      ScriptingPackageRevision,
      User,
      Room,
    ]),
  ],
  providers: [
    ScriptingPackagesService,
    PackageRevisionsService,
    PackageWorkshopService,
    PackagePublishLockService,
    UsersService,
  ],
  // `WorkshopController` must come first: `GET /scripting-packages/workshop`
  // would otherwise be matched by the authoring `GET /scripting-packages/:id`
  // and rejected by its `ParseIntPipe`. The delivery controller is declared by
  // `PackageDeliveryModule`, whose routes are all under `:id/revisions/...`, so
  // it cannot shadow a literal path.
  controllers: [WorkshopController, ScriptingPackagesController],
  exports: [
    ScriptingPackagesService,
    PackageRevisionsService,
    PackagePublishLockService,
  ],
})
export class ScriptingPackagesModule {}
