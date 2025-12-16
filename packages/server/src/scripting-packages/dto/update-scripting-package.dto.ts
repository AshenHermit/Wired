import { PartialType } from '@nestjs/swagger';
import { CreateScriptingPackageDto } from './create-scripting-package.dto';

export class UpdateScriptingPackageDto extends PartialType(
  CreateScriptingPackageDto,
) {}
