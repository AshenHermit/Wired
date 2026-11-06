import { ApiProperty } from '@nestjs/swagger';
import { RoomAccessMode } from '@wired-io/shared';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
} from 'class-validator';

/**
 * Update body for package access policies. All fields are optional to allow
 * partial updates. The user IDs are validated server-side to ensure they exist.
 */
export class UpdatePackageAccessDto {
  @ApiProperty({
    example: 'users',
    description: 'Package editing access mode',
    enum: ['all', 'author', 'users'],
    required: false,
  })
  @IsOptional()
  @IsEnum(['all', 'author', 'users'] as const)
  editingAccess?: RoomAccessMode;

  @ApiProperty({
    example: [1, 2, 3],
    description: 'User IDs allowed to edit package',
    required: false,
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  editingUserIds?: number[];
}
