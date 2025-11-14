import { Module } from '@nestjs/common';
import { ScriptCompilerController } from './script-compiler.controller';
import { ScriptCompilerService } from './script-compiler.service';

@Module({
  providers: [ScriptCompilerService],
  controllers: [ScriptCompilerController],
})
export class ScriptCompilerModule {}
