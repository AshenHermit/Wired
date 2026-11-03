import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Req,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ApiOkResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { UseAuthGuard, SilentAuth } from 'src/auth/auth-policy';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';
import { User } from 'src/database/entities/user.entity';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * The signed-in user, or an empty 200 for an anonymous caller.
   *
   * `null` is a real answer here, not a failure: the page loads for visitors
   * who have no session yet, and they must not see an error.
   */
  @SilentAuth()
  @ApiOkResponse({
    description: 'The signed-in user, or no body for an anonymous caller.',
    schema: { nullable: true, allOf: [{ $ref: getSchemaPath(User) }] },
  })
  @Get('profile')
  getProfile(@Req() req: SilentAuthRequest): User | null {
    return req.user;
  }

  @UseAuthGuard()
  @ApiOkResponse({ type: User })
  @Patch(':userId')
  async updateUser(
    @Param('userId', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<User> {
    await this.usersService.assertUserEditing(req.user, id);
    return this.usersService.update(id, dto);
  }

  @UseAuthGuard()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':userId')
  async deleteUser(
    @Param('userId', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.usersService.assertUserEditing(req.user, id);
    await this.usersService.remove(id);
  }
}
