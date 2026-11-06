import { ApiProperty } from '@nestjs/swagger';
import { RoomAccessMode } from '@wired-io/shared';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
} from 'class-validator';

/**
 * Update body for room access policies. All fields are optional to allow
 * partial updates. The user IDs are validated server-side to ensure they exist.
 */
export class UpdateRoomAccessDto {
  @ApiProperty({
    example: 'users',
    description: 'Package management access mode',
    enum: ['all', 'author', 'users'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['all', 'author', 'users'] as const)
  packageManagementAccess?: RoomAccessMode;

  @ApiProperty({
    example: [1, 2, 3],
    description: 'User IDs allowed to manage packages',
    required: false,
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  packageManagementUserIds?: number[];

  @ApiProperty({
    example: 'author',
    description: 'Package creation access mode',
    enum: ['all', 'author', 'users'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['all', 'author', 'users'] as const)
  packageCreationAccess?: RoomAccessMode;

  @ApiProperty({
    example: [1, 2],
    description: 'User IDs allowed to create packages',
    required: false,
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  packageCreationUserIds?: number[];
}
