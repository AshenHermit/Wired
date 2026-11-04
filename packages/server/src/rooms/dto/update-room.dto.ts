import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

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
}
