import { ApiProperty } from '@nestjs/swagger';
import {
  AVAILABLE_GAME_ROOMS_TYPES,
  CreatableRoomType,
} from '@wired-io/shared';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsWiredMediaUrl } from 'src/media/is-wired-media-url.decorator';

/**
 * Room creation body. The author is never part of the payload: it always comes
 * from the authenticated request, so a client cannot create a room for someone
 * else by echoing another id.
 */
export class CreateRoomDto {
  @ApiProperty({ example: 'My room', description: 'Room title' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({
    example: true,
    description: 'Is room publicly visible',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiProperty({
    example: 'Some description',
    description: 'Room description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 2,
    description: 'Parent room id',
    required: false,
  })
  @IsOptional()
  @IsInt()
  parentRoomId?: number;

  @ApiProperty({
    example: 'godot',
    description: 'Room type',
    enum: AVAILABLE_GAME_ROOMS_TYPES,
  })
  @IsEnum(AVAILABLE_GAME_ROOMS_TYPES)
  type: CreatableRoomType;

  @ApiProperty({
    example: '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    description: 'Optional preview image URL from POST /media',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsWiredMediaUrl()
  previewImage?: string | null;
}
