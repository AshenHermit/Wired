import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsWiredMediaUrl } from 'src/media/is-wired-media-url.decorator';

/**
 * The mutable room fields. Declared explicitly rather than as
 * `PartialType(CreateRoomDto)` so `type` and the author cannot be whitelisted
 * into a body the service then silently ignores.
 */
export class UpdateRoomDto {
  @ApiProperty({ example: 'My room', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiProperty({ example: 'Some description', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 2, required: false })
  @IsOptional()
  @IsInt()
  parentRoomId?: number;

  @ApiProperty({
    example: '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    required: false,
    nullable: true,
    description: 'Set a /media URL or null to clear; omit to leave unchanged',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsWiredMediaUrl()
  previewImage?: string | null;
}
