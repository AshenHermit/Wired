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
  Query,
  Req,
  BadRequestException,
} from '@nestjs/common';
import type { PublicUser } from '@wired-io/shared';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ApiOkResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { UseAuthGuard, SilentAuth } from 'src/auth/auth-policy';
import { AuthenticatedRequest, SilentAuthRequest } from 'src/auth/jwt.strategy';
import { User } from 'src/database/entities/user.entity';

/** Result cap for the user search; a picker never needs more than this. */
const USER_SEARCH_MAX_LIMIT = 50;
/** Page size when the caller omits `?limit=`. */
const USER_SEARCH_DEFAULT_LIMIT = 20;

/**
 * `?limit=` (blank) reaches the handler as an empty string and `Number('')` is
 * `0`, which would silently clamp to 1 instead of the documented default. A
 * repeated parameter (`?limit=1&limit=2`) arrives as an array; both are treated
 * as "not given".
 */
function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return Number(value.trim());
}

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

  /**
   * Authenticated lookup for the access-list picker. Searches name and email
   * case-insensitively and returns only public fields, so the caller learns
   * the real user id without gaining their email or any private data.
   */
  @UseAuthGuard()
  @ApiOkResponse({
    description:
      'Users matching `q`, projected to public fields (id, name, picture).',
  })
  @Get('search')
  search(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<PublicUser[]> {
    const query = q?.trim() ?? '';
    if (query.length === 0) {
      throw new BadRequestException(
        'A non-empty `q` query parameter is required',
      );
    }
    const requested = parseOptionalNumber(limit);
    const capped = Math.min(
      Math.max(requested ?? USER_SEARCH_DEFAULT_LIMIT, 1),
      USER_SEARCH_MAX_LIMIT,
    );
    return this.usersService.search(query, capped);
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
