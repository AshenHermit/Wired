import { Module } from '@nestjs/common';
import { GodotEditorProviderController } from './godot-editor-provider.controller';
import { AppConfigModule } from 'src/config/config.module';

@Module({
  imports: [AppConfigModule],
  controllers: [GodotEditorProviderController],
  providers: [],
})
export class GodotEditorProviderModule {}
