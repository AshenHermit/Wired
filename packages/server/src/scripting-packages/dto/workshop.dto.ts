import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
  @MaxLength(64)
  @Matches(/^(?=.*[a-z])[a-z0-9_]+$/, {
    message:
      'slug must contain lowercase latin letters, digits or _, and at least one letter',
  })
  slug: string;
}

export class RoomCopyDto {
  @ApiProperty({ example: 1, description: 'Room to copy the package into' })
  @IsInt()
  roomId: number;
}
