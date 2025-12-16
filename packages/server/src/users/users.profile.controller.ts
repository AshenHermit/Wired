import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDTO } from '../auth/create-user.dto';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { User } from 'src/database/entities/user.entity';
import { UseSilentAuthQuard } from 'src/auth/jwt-auth.guard';
import { SilentAuthRequest } from 'src/auth/jwt.strategy';

@Controller('users/profile')
export class UsersProfileController {
  constructor(private readonly usersService: UsersService) {}

  @UseSilentAuthQuard()
  @ApiOkResponse({ type: User })
  @Get()
  async getProfile(@Req() req: SilentAuthRequest) {
    return req.user;
  }
}
