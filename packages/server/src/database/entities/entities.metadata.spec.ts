import { DataSource } from 'typeorm';
import { Room } from './room.entity';
import { User } from './user.entity';
import { ScriptingPackage } from './scripting-package.entity';
import { ScriptingPackageRevision } from './scripting-package-revision.entity';

describe('entity metadata', () => {
  it('builds postgres metadata for every entity', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      entities: [Room, User, ScriptingPackage, ScriptingPackageRevision],
    });

    // buildMetadatas runs the same validation as a real connection and fails
    // on unsupported column types such as `Object`.
    const build = (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas.bind(dataSource);

    await expect(build()).resolves.toBeUndefined();
  });
});
