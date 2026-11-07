import { isWiredMediaUrl } from '@wired-io/shared';
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isWiredMediaUrl', async: false })
export class IsWiredMediaUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isWiredMediaUrl(value);
  }

  defaultMessage(): string {
    return 'previewImage must be a Wired /media/<hash>.<ext> URL';
  }
}

/** Validates a non-null preview URL. Pair with `@IsOptional()` so `null` clears. */
export function IsWiredMediaUrl(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsWiredMediaUrlConstraint,
    });
  };
}
