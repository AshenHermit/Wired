import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Req,
} from '@nestjs/common';
import { UsersService, UpdateUserDTO } from './users.service';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { UseAuthGuard, UseSilentAuthGuard } from 'src/auth/jwt-auth.guard';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';
import { User } from 'src/database/entities/user.entity';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Declared before the parameterised routes so /users/profile is not
  // captured by /users/:userId + ParseIntPipe.
  @UseSilentAuthGuard()
  @ApiOkResponse({ type: User })
  @Get('profile')
  getProfile(@Req() req: SilentAuthRequest) {
    return req.user;
  }

  @UseAuthGuard()
  @Patch(':userId')
  async updateUser(
    @Param('userId', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDTO,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.usersService.assertUserEditing(req.user, id);
    await this.usersService.update(id, dto);
  }

  @UseAuthGuard()
  @Delete(':userId')
  async deleteUser(
    @Param('userId', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.usersService.assertUserEditing(req.user, id);
    await this.usersService.remove(id);
  }
}
