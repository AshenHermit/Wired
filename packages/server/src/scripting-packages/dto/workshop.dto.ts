import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { IsPackageSlug } from './package-slug.decorator';

export class WorkshopPublishDto {
  @ApiProperty({
    example: 'My package',
    description: 'Workshop title override',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiProperty({
    example: '0.1.0',
    description: 'Workshop version override',
    required: false,
  })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiProperty({
    example: 'Some description',
    description: 'Workshop description override',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Workshop tags',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class WorkshopForkDto {
  @ApiProperty({ example: 'hero_controller' })
  @IsString()
  @IsPackageSlug()
  slug: string;
}
