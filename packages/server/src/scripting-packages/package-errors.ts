import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Failures the artifact builder reports about package references. Clients
 * switch on `code` and read the named field, so a failure is never recovered
 * by parsing the human-readable message.
 */
export type PackageDependencyErrorCode =
  | 'package_dependency_not_global'
  | 'package_dependency_unknown_slug'
  | 'package_dependency_missing_file'
  | 'package_dependency_cycle'
  | 'package_dependency_unpublished'
  | 'package_dependency_room_mismatch';

export interface PackageDependencyErrorDetails {
  slug?: string;
  packageId?: number;
  filepath?: string;
  cycle?: string;
}

/**
 * One envelope for every dependency failure. `message` stays readable for
 * logs; the client only needs `code` plus the offending identifier.
 */
export function packageDependencyError(
  code: PackageDependencyErrorCode,
  message: string,
  details: PackageDependencyErrorDetails = {},
): BadRequestException {
  return new BadRequestException({ code, message, ...details });
}

/**
 * Failures of the package HTTP surface that are not about dependency
 * resolution: delivery, read tokens and the membership of the calling runtime.
 *
 * They share the dependency envelope on purpose. `packageDependencyError` used
 * to be the only place a code was put in `code`; everywhere else the code was
 * thrown as the Nest `message`, where no client could reach it without parsing
 * prose.
 */
export type PackageErrorCode =
  | 'package_artifact_not_found'
  | 'package_artifact_key_missing'
  | 'package_artifact_file_missing'
  | 'package_read_token_invalid'
  | 'package_read_secret_missing'
  | 'package_not_attached_to_room'
  | 'room_invalid'
  | 'room_not_found'
  | 'room_access_denied'
  | 'authentication_required';

/**
 * The status each code answers with. Kept beside the codes so a caller states
 * what went wrong and not which HTTP verb to reply with, and so the two places
 * that report the same failure cannot pick different statuses.
 */
const STATUS_BY_CODE: Record<PackageErrorCode, HttpStatus> = {
  package_artifact_not_found: HttpStatus.NOT_FOUND,
  package_artifact_key_missing: HttpStatus.BAD_REQUEST,
  package_artifact_file_missing: HttpStatus.NOT_FOUND,
  package_read_token_invalid: HttpStatus.UNAUTHORIZED,
  package_read_secret_missing: HttpStatus.SERVICE_UNAVAILABLE,
  package_not_attached_to_room: HttpStatus.FORBIDDEN,
  room_invalid: HttpStatus.BAD_REQUEST,
  room_not_found: HttpStatus.NOT_FOUND,
  room_access_denied: HttpStatus.FORBIDDEN,
  authentication_required: HttpStatus.UNAUTHORIZED,
};

/**
 * The Nest exception class that carries a status, so a caller that catches by
 * class (`ForbiddenException`) keeps working while the body carries `code`.
 */
function exceptionFor(status: HttpStatus, body: object): HttpException {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return new BadRequestException(body);
    case HttpStatus.UNAUTHORIZED:
      return new UnauthorizedException(body);
    case HttpStatus.FORBIDDEN:
      return new ForbiddenException(body);
    case HttpStatus.NOT_FOUND:
      return new NotFoundException(body);
    case HttpStatus.SERVICE_UNAVAILABLE:
      return new ServiceUnavailableException(body);
    default:
      return new HttpException(body, status);
  }
}

/**
 * A package failure whose code reaches the client. `message` stays readable for
 * logs; clients switch on `code`.
 */
export function packageError(
  code: PackageErrorCode,
  message: string,
): HttpException {
  return exceptionFor(STATUS_BY_CODE[code], { code, message });
}

/**
 * A slug that a room or the workshop already holds.
 *
 * Three call sites write the same payload - one before the insert and two after
 * a unique violation - so the shape lives here and cannot drift between them.
 */
export function packageSlugTaken(slug: string): ConflictException {
  return new ConflictException({
    code: 'slug_taken',
    slug,
    message: 'Slug уже занят',
  });
}
