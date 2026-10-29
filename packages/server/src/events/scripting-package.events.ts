import { PackageRevision } from '@wired-io/shared';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';

export class ScriptingPackageCreatedEvent {
  constructor(public readonly scriptingPackage: ScriptingPackage) {}
}
export class ScriptingPackageUpdatedEvent {
  constructor(public readonly scriptingPackage: ScriptingPackage) {}
}
export class ScriptingPackageDeletedEvent {
  constructor(public readonly scriptingPackage: ScriptingPackage) {}
}
export class ScriptingPackageRevisionPublishedEvent {
  constructor(
    public readonly scriptingPackage: ScriptingPackage,
    public readonly revision: PackageRevision,
  ) {}
}

export class ScriptingPackageEvents {
  static readonly SCRIPTING_PACKAGE_CREATED = 'scripting-package.created';
  static readonly SCRIPTING_PACKAGE_UPDATED = 'scripting-package.updated';
  static readonly SCRIPTING_PACKAGE_DELETED = 'scripting-package.deleted';
  static readonly SCRIPTING_PACKAGE_REVISION_PUBLISHED =
    'scripting-package.revision.published';
}
