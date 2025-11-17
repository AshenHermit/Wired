import { Controller, Get, Header } from '@nestjs/common';
import { TypesService } from './types.service';

@Controller('types')
export class TypesController {
  constructor(private readonly typesService: TypesService) {}

  @Get('wired-io')
  async getSharedTypes() {
    return await this.typesService.getSharedTypings();
  }
  @Get('libs')
  async getLibsTypes() {
    return await this.typesService.getLibsTypings();
  }
}
