import {
  applyDecorators,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth } from '@nestjs/swagger';
import { User } from 'src/database/entities/user.entity';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

@Injectable()
export class JwtSilentAuthGuard extends AuthGuard('jwt-silent') {
  handleRequest<TUser = User | null>(
    err: any,
    user: TUser,
    info: any,
    context: ExecutionContext,
    status?: any,
  ): TUser {
    return user ?? (null as TUser);
  }
}

export function UseAuthGuard() {
  return applyDecorators(UseGuards(JwtAuthGuard), ApiBearerAuth());
}

export function UseSilentAuthGuard() {
  return applyDecorators(UseGuards(JwtSilentAuthGuard), ApiBearerAuth());
}
