import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';

import { AssetBakeCache } from './asset-bake-cache';
import { AssetBakeService } from './asset-bake.service';
import { PackageDeliveryModule } from './package-delivery.module';

async function createModule(): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [PackageDeliveryModule] })
    .overrideProvider(getRepositoryToken(ScriptingPackage))
    .useValue({})
    .overrideProvider(getRepositoryToken(ScriptingPackageRevision))
    .useValue({})
    .overrideProvider(getRepositoryToken(Room))
    .useValue({})
    .compile();
}

describe('PackageDeliveryModule', () => {
  it('собирает AssetBakeService с путями из конфигурации', async () => {
    const moduleRef = await createModule();

    const service = moduleRef.get(AssetBakeService);

    expect(service).toBeInstanceOf(AssetBakeService);
    expect(moduleRef.get(AssetBakeCache)).toBeInstanceOf(AssetBakeCache);
  });
});
