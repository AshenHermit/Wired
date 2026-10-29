import { BadRequestException } from '@nestjs/common';
import path from 'path';
import { AppConfigService } from 'src/config/config.service';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackagesService } from './scripting-packages.service';

const root =
  process.platform === 'win32' ? 'C:\\storage\\packages' : '/storage/packages';

function createService(): ScriptingPackagesService {
  return new ScriptingPackagesService(
    undefined as never,
    undefined as never,
    undefined as never,
    { emit: jest.fn() } as never,
    {
      storage: { packagesFilesDir: root, dir: root },
    } as unknown as AppConfigService,
  );
}

const pkg = { id: 7 } as ScriptingPackage;

describe('ScriptingPackagesService.getPhysicalFileFullPath', () => {
  it('keeps legacy files inside the package directory', () => {
    expect(
      createService().getPhysicalFileFullPath(pkg, 'scripts/hero.gd'),
    ).toBe(path.join(root, '7', 'scripts', 'hero.gd'));
  });

  it('refuses to leave the package directory', () => {
    const service = createService();

    expect(() =>
      service.getPhysicalFileFullPath(pkg, '../../other-package/secret.gd'),
    ).toThrow(BadRequestException);
    expect(() =>
      service.getPhysicalFileFullPath(
        pkg,
        'C:/Windows/system32/drivers/etc/hosts',
      ),
    ).toThrow(BadRequestException);
  });

  it('refuses to reach revision storage through the legacy API', () => {
    const service = createService();

    expect(() =>
      service.getPhysicalFileFullPath(pkg, 'drafts/3/hero.gd'),
    ).toThrow(BadRequestException);
    expect(() =>
      service.getPhysicalFileFullPath(pkg, 'revisions/1/hero.gd'),
    ).toThrow(BadRequestException);
  });
});
