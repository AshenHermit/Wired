import { ApiProperty } from '@nestjs/swagger';

export class AuthTokenDto {
  @ApiProperty({
    example: 'abcde123abcde123abcde123',
    description: 'access token',
  })
  access_token: string;
}
