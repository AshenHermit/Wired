import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { TypesService } from './types.service';

@Controller('types')
export class TypesController {
  constructor(private readonly typesService: TypesService) {}

  @Get('wired-io')
  @HttpCode(HttpStatus.OK)
  async getSharedTypes() {
    try {
      const result = await this.typesService.getSharedTypings();
      return result || [];
    } catch (error) {
      console.error('Error in getSharedTypes:', error);
      throw error;
    }
  }
  @Get('libs')
  async getLibsTypes() {
    return await this.typesService.getLibsTypings();
  }
}
