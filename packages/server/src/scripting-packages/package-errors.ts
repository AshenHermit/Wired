import { BadRequestException } from '@nestjs/common';

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
