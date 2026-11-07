import { BadRequestException } from '@nestjs/common';
import { createValidationPipe } from 'src/common/validation';
import { UpdateScriptingPackageDto } from './update-scripting-package.dto';

describe('UpdateScriptingPackageDto previewImage', () => {
  const pipe = createValidationPipe();
  const transform = (payload: Record<string, unknown>) =>
    pipe.transform(payload, {
      type: 'body',
      metatype: UpdateScriptingPackageDto,
    });

  it('accepts a wired media URL', async () => {
    await expect(
      transform({ previewImage: `/media/${'b'.repeat(64)}.jpg` }),
    ).resolves.toBeInstanceOf(UpdateScriptingPackageDto);
  });

  it('accepts null to clear the preview', async () => {
    await expect(
      transform({ previewImage: null }),
    ).resolves.toBeInstanceOf(UpdateScriptingPackageDto);
  });

  it('rejects an external URL', async () => {
    await expect(
      transform({ previewImage: 'https://evil.example/x.png' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a traversal-shaped path', async () => {
    await expect(
      transform({ previewImage: '/media/../x.png' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
