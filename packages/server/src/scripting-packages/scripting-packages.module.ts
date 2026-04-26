import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { ScriptingPackagesController } from './scripting-packages.controller';
import { AppConfigModule } from 'src/config/config.module';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([ScriptingPackage, User, Room]),
  ],
  providers: [ScriptingPackagesService],
  controllers: [ScriptingPackagesController],
  exports: [ScriptingPackagesService],
})
export class ScriptingPackagesModule {}
