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

export class ScriptingPackageEvents {
  static readonly SCRIPTING_PACKAGE_CREATED = 'scripting-package.created';
  static readonly SCRIPTING_PACKAGE_UPDATED = 'scripting-package.updated';
  static readonly SCRIPTING_PACKAGE_DELETED = 'scripting-package.deleted';
}
