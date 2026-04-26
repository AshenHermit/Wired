import { ApiProperty } from '@nestjs/swagger';
import { GAME_ROOMS_TYPES, GameRoomsType } from '@wired-io/shared';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

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
    example: 1,
    description: 'Author user id',
  })
  @IsInt()
  authorId: number;

  @ApiProperty({
    example: 2,
    description: 'Parent room id',
    required: false,
  })
  @IsOptional()
  @IsInt()
  parentRoomId?: number;

  @ApiProperty({
    example: 'ts-game',
    description: 'Room type',
    enum: GAME_ROOMS_TYPES,
  })
  @IsEnum(GAME_ROOMS_TYPES)
  type: GameRoomsType;
}
