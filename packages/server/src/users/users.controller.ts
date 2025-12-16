import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { UsersService, UpdateUserDTO } from './users.service';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { User } from 'src/database/entities/user.entity';
import { CreateUserDTO } from '../auth/create-user.dto';
import { UseAuthQuard } from 'src/auth/jwt-auth.guard';
import { AuthenticatedRequest } from 'src/auth/jwt.strategy';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOkResponse({ type: [User] })
  @Get()
  async getUsers() {
    return this.usersService.findAll();
  }

  @ApiOkResponse({ type: User })
  @Get(':userId')
  async getUser(@Param('userId', ParseIntPipe) id: number) {
    const user = await this.usersService.getById(id);
    return user;
  }

  @ApiOkResponse({ type: User })
  @Post()
  async createUser(@Body() dto: CreateUserDTO) {
    return this.usersService.create(dto);
  }

  @UseAuthQuard()
  @Patch(':userId')
  async updateUser(
    @Param('userId', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDTO,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.usersService.assertUserEditing(req.user, id);
    await this.usersService.update(id, dto);
  }

  @UseAuthQuard()
  @Delete(':userId')
  async deleteUser(
    @Param('userId', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.usersService.assertUserEditing(req.user, id);
    await this.usersService.remove(id);
  }
}
