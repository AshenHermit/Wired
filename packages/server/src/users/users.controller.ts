import {
  Body,
  Controller,
  Delete,
  Param,
  ParseIntPipe,
  Patch,
  Req,
} from '@nestjs/common';
import { UsersService, UpdateUserDTO } from './users.service';
import { ApiTags } from '@nestjs/swagger';
import { UseAuthGuard } from 'src/auth/jwt-auth.guard';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
