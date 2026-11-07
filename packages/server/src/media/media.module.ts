import { Module } from '@nestjs/common';
import { AppConfigModule } from 'src/config/config.module';
import { MediaController } from './media.controller';
import { MediaStorageService } from './media-storage.service';

@Module({
  imports: [AppConfigModule],
  controllers: [MediaController],
  providers: [MediaStorageService],
  exports: [MediaStorageService],
})
export class MediaModule {}
