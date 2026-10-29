import { Controller, Get, Req } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { User } from 'src/database/entities/user.entity';
import { UseSilentAuthGuard } from 'src/auth/jwt-auth.guard';
import { SilentAuthRequest } from 'src/auth/jwt.strategy';

@Controller('users/profile')
export class UsersProfileController {
  @UseSilentAuthGuard()
  @ApiOkResponse({ type: User })
  @Get()
  getProfile(@Req() req: SilentAuthRequest) {
    return req.user;
  }
}
