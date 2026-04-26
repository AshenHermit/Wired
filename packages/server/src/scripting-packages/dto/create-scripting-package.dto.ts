import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ScriptFile } from 'src/database/entities/scripting-package.entity';
import { PhysicalFile } from '@wired-io/shared';

class ScriptFileDto implements ScriptFile {
  @ApiProperty({ example: 'main.ts', description: 'Script file path' })
  @IsString()
  filepath: string;

  @ApiProperty({
    example: 'console.log(\"hello\")',
    description: 'Script body',
  })
  @IsString()
  script: string;
}

class PhysicalFileDto implements PhysicalFile {
  @ApiProperty({ example: 'main.ts', description: 'Physical file path' })
  @IsString()
  filepath: string;

  @ApiProperty({ example: '1234567890', description: 'Physical file hash' })
  @IsOptional()
  @IsString()
  hash?: string;
}

export class CreateScriptingPackageDto {
  @ApiProperty({ example: 'My package', description: 'Package title' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ example: '0.1.0', description: 'Package version' })
  @IsString()
  version: string;

  @ApiProperty({
    example: 'Some description',
    description: 'Package description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Package dependencies',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependencies?: string[];

  @ApiProperty({
    description: 'Package scripts',
    required: false,
    type: [ScriptFileDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScriptFileDto)
  scripts?: ScriptFile[];

  @ApiProperty({
    description: 'Package physical files',
    required: false,
    type: [PhysicalFileDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PhysicalFileDto)
  physicalFiles?: PhysicalFile[];

  @ApiProperty({
    example: 1,
    description: 'Author user id',
    required: false,
  })
  @IsOptional()
  @IsInt()
  authorId?: number;

  @ApiProperty({
    example: 1,
    description: 'Room id for package',
    required: false,
  })
  @IsOptional()
  @IsInt()
  roomId?: number;

  @ApiProperty({
    example: 1,
    description: 'Parent package id',
    required: false,
  })
  @IsOptional()
  @IsInt()
  parentPackageId?: number;
}
