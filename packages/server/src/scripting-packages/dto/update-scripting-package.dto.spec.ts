import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateScriptingPackageDto } from './update-scripting-package.dto';

async function enabledErrors(enabled: unknown) {
  const dto = plainToInstance(UpdateScriptingPackageDto, { enabled });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'enabled');
}

describe('UpdateScriptingPackageDto', () => {
  it('accepts a boolean enabled flag', async () => {
    expect(await enabledErrors(false)).toHaveLength(0);
    expect(await enabledErrors(true)).toHaveLength(0);
  });

  it('rejects a non-boolean enabled flag', async () => {
    expect(await enabledErrors('false')).toHaveLength(1);
  });

  it('accepts an empty payload', async () => {
    const dto = plainToInstance(UpdateScriptingPackageDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });
});
