import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { IsString } from 'class-validator';
import { createValidationPipe } from './validation';

class SampleDto {
  @IsString()
  name!: string;
}

describe('createValidationPipe', () => {
  it('builds a Nest ValidationPipe', () => {
    expect(createValidationPipe()).toBeInstanceOf(ValidationPipe);
  });

  it('rejects a property the DTO does not declare', async () => {
    const pipe = createValidationPipe();

    await expect(
      pipe.transform(
        { name: 'hero', id: 99 },
        { type: 'body', metatype: SampleDto, data: '' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a value that fails the DTO decorators', async () => {
    const pipe = createValidationPipe();

    await expect(
      pipe.transform(
        { name: 42 },
        { type: 'body', metatype: SampleDto, data: '' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
