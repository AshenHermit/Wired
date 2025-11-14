import { Controller, Get, Module } from '@nestjs/common';
import { ScriptCompilerService } from './script-compiler.service';

@Controller('script-compiler')
export class ScriptCompilerController {
  constructor(private readonly scriptCompilerService: ScriptCompilerService) {}

  @Get('compile')
  async compile() {
    return await this.scriptCompilerService.compile();
  }
}
