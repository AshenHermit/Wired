import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsPackageSlug } from './package-slug.decorator';
import { IsWiredMediaUrl } from 'src/media/is-wired-media-url.decorator';

export class CreateScriptingPackageDto {
  @ApiProperty({ example: 'hero_controller' })
  @IsString()
  @IsPackageSlug()
  slug: string;

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
    description: 'Workshop tags',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

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

  @ApiProperty({
    example: '/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp',
    description: 'Optional preview image URL from POST /media',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsWiredMediaUrl()
  previewImage?: string | null;
}
