import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { GoogleOauthGuard } from './google/auth-google.guard';
import { Response } from 'express';
import { GoogleAuthenticatedRequest } from './google/auth-google.strategy';
import { AppConfigService } from 'src/config/config.service';
import { ApiOkResponse } from '@nestjs/swagger';
import { UsersService } from 'src/users/users.service';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { AuthTokenDto } from './dto/auth-token.dto';
import { AuthUserDto } from './dto/auth-user.dto';
import { Public, UseAuthGuard } from './auth-policy';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post('register')
  @ApiOkResponse({ type: AuthTokenDto })
  async register(@Body() createUserDto: CreateUserDto) {
    await this.usersService.create(createUserDto);
    return await this.authService.login(
      createUserDto.email,
      createUserDto.password,
    );
  }

  @Public()
  @Post('login')
  @ApiOkResponse({ type: AuthTokenDto })
  async login(
    @Res({ passthrough: true }) res: Response,
    @Body() body: AuthUserDto,
  ) {
    const token = await this.authService.login(body.email, body.password);
    this.authService.writeCookie(res, token);
    return token;
  }
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseAuthGuard()
  logout(@Res({ passthrough: true }) res: Response): void {
    this.authService.clearCookie(res);
  }

  @Public()
  @Get('google')
  @UseGuards(GoogleOauthGuard)
  async google() {}

  @Public()
  @Get('callback/google')
  @UseGuards(GoogleOauthGuard)
  async googleCallback(
    @Req() req: GoogleAuthenticatedRequest,
    @Res() res: Response,
  ) {
    const user = req?.user;
    const token = await this.authService.forceLogin(
      user.email,
      user.name,
      user.picture,
      '',
    );
    this.authService.writeCookie(res, token);

    return res.redirect(this.config.site.host);
  }
}
