import { applyDecorators } from '@nestjs/common';
import {
  PACKAGE_SLUG_MAX_LENGTH,
  PACKAGE_SLUG_PATTERN,
} from '@wired-io/shared';
import { Matches, MaxLength } from 'class-validator';

/**
 * Validation for a package slug field. The rule itself lives in
 * `@wired-io/shared` so the server, the service and the editor dialogs cannot
 * drift apart.
 */
export const IsPackageSlug = () =>
  applyDecorators(
    MaxLength(PACKAGE_SLUG_MAX_LENGTH),
    Matches(PACKAGE_SLUG_PATTERN, {
      message:
        'slug must contain lowercase latin letters, digits or _, and at least one letter',
    }),
  );
