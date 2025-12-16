import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { UseAuthQuard } from 'src/auth/jwt-auth.guard';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';

@ApiTags('scripting-packages')
@Controller('scripting-packages')
export class ScriptingPackagesController {
  constructor(private readonly packagesService: ScriptingPackagesService) {}

  @ApiOkResponse({ type: [ScriptingPackage] })
  @Get()
  findAll() {
    return this.packagesService.findAll();
  }

  @ApiOkResponse({ type: ScriptingPackage })
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.packagesService.findOne(id);
  }

  @UseAuthQuard()
  @ApiOkResponse({ type: ScriptingPackage })
  @Post()
  async create(
    @Body() dto: CreateScriptingPackageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.packagesService.assertPackageCreation(req.user, dto);
    return await this.packagesService.create(dto);
  }

  @UseAuthQuard()
  @ApiOkResponse({ type: ScriptingPackage })
  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateScriptingPackageDto,
  ) {
    await this.packagesService.assertPackageEditing(req.user, id);
    return await this.packagesService.update(id, dto);
  }

  @UseAuthQuard()
  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.packagesService.assertPackageEditing(req.user, id);
    return await this.packagesService.remove(id);
  }
}
