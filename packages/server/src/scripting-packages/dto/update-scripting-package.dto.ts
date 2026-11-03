import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

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

  @ApiPropertyOptional({ description: 'Workshop tags', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

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

  @ApiPropertyOptional({
    example: 'hero_2',
    description: 'New slug; the service rewrites package references',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Confirms a rename that published dependents point to',
  })
  @IsOptional()
  @IsBoolean()
  confirmSlugRename?: boolean;
}
