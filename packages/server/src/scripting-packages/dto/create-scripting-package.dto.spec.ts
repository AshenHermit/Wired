import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateScriptingPackageDto } from './create-scripting-package.dto';

async function slugErrors(slug: unknown) {
  const dto = plainToInstance(CreateScriptingPackageDto, {
    name: 'Hero',
    version: '0.1.0',
    slug,
  });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'slug');
}

describe('CreateScriptingPackageDto slug', () => {
  it.each(['hero', 'hero_controller', 'h2', 'a_b_c'])(
    'accepts %s',
    async (slug) => {
      expect(await slugErrors(slug)).toHaveLength(0);
    },
  );

  it.each([
    '',
    '123',
    'Hero',
    'hero-controller',
    'hero controller',
    'héro',
    'a'.repeat(65),
  ])('rejects %s', async (slug) => {
    expect(await slugErrors(slug)).toHaveLength(1);
  });
});
