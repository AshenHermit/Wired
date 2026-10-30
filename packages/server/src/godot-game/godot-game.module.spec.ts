import { GodotGameModule } from './godot-game.module';
import { PackageSyncService } from './package-sync.service';
import { PACKAGE_REVISION_DISPATCHER } from './package-sync.types';

describe('GodotGameModule wiring', () => {
  it('exports the publish dispatcher consumed by ScriptingPackagesModule', () => {
    const exports = Reflect.getMetadata(
      'exports',
      GodotGameModule,
    ) as unknown[];

    expect(exports).toEqual(
      expect.arrayContaining([PackageSyncService, PACKAGE_REVISION_DISPATCHER]),
    );
  });
});
