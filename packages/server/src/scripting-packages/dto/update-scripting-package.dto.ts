import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ScriptFile } from 'src/database/entities/scripting-package.entity';
import { PhysicalFile } from '@wired-io/shared';
import { ScriptFileDto, PhysicalFileDto } from './create-scripting-package.dto';

export class UpdateScriptingPackageDto {
  @ApiPropertyOptional({ example: 'My package', description: 'Package title' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: '0.1.0', description: 'Package version' })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional({
    example: 'Some description',
    description: 'Package description',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Package dependencies',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependencies?: string[];

  @ApiPropertyOptional({
    description: 'Package scripts',
    type: [ScriptFileDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScriptFileDto)
  scripts?: ScriptFile[];

  @ApiPropertyOptional({
    description: 'Package physical files',
    type: [PhysicalFileDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PhysicalFileDto)
  physicalFiles?: PhysicalFile[];

  @ApiPropertyOptional({ example: 1, description: 'Parent package id' })
  @IsOptional()
  @IsInt()
  parentPackageId?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'package is active in its room',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
