import { DataSource } from 'typeorm';
import { Room } from './room.entity';
import { User } from './user.entity';
import { ScriptingPackage } from './scripting-package.entity';
import { ScriptingPackageRevision } from './scripting-package-revision.entity';

function createDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    entities: [
      Room,
      User,
      ScriptingPackage,
      ScriptingPackageRevision,
    ],
  });
}

// buildMetadatas runs the same validation as a real connection and fails
// on unsupported column types such as `Object`.
type MetadataBuilder = { buildMetadatas(): Promise<void> };

async function buildMetadatas(dataSource: DataSource): Promise<void> {
  await (dataSource as unknown as MetadataBuilder).buildMetadatas();
}

describe('entity metadata', () => {
  it('builds postgres metadata for every entity', async () => {
    await expect(buildMetadatas(createDataSource())).resolves.toBeUndefined();
  });

  it('exposes workshop tags and a non-unique slug on ScriptingPackage', async () => {
    const dataSource = createDataSource();
    await buildMetadatas(dataSource);

    const meta = dataSource.getMetadata(ScriptingPackage);
    const slug = meta.findColumnWithPropertyName('slug')!;
    expect(slug).toBeDefined();
    // TypeORM 0.3 has no `ColumnMetadata.isUnique`; the driver derives the
    // same value from the entity's single-column unique constraints.
    expect(dataSource.driver.normalizeIsUnique(slug)).toBe(false);
    const tags = meta.findColumnWithPropertyName('tags')!;
    expect(tags.type).toBe('jsonb');
    expect(tags.default).toEqual([]);
    expect(dataSource.driver.normalizeDefault(tags)).toBe("'[]'");
  });
});
