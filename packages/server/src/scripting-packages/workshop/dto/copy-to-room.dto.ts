import { ApiProperty } from '@nestjs/swagger';
import { IsInt } from 'class-validator';

/** Target room for copying a workshop package into. */
export class CopyToRoomDto {
  @ApiProperty({ example: 1, description: 'Room to copy the package into' })
  @IsInt()
  roomId: number;
}
