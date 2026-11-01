extends RefCounted
class_name PackageEntryLoader

## Loads the root `wired_package.gd` entry of one applied package revision.
##
## The entry is a plain script extending `WiredPackageRegistration`; it never
## declares `class_name`. The loader resolves the script through the revision
## context, instantiates it, and copies its declarative content into the shared
## `WiredPackageRegistry`. A package without an entry script is valid and simply
## contributes no content, so `load_entry` then returns false.
##
## The script is loaded with `CACHE_MODE_REPLACE`: a same-revision rebuild can
## replace the artifact bytes, and the registry must register the new script,
## not the one the engine cached from the previous artifact key.

const ENTRY_FILE := "wired_package.gd"


static func load_entry(
	package_id: String,
	revision: int,
	context: WiredPackageContext,
	registry: WiredPackageRegistry
) -> bool:
	if context == null or registry == null:
		push_warning(
			"WIRED_PACKAGE_ENTRY_SKIPPED package=%s revision=%d reason=missing_service"
			% [package_id, revision]
		)
		return false
	var path := context.scene_path(ENTRY_FILE)
	if not ResourceLoader.exists(path):
		return false
	var script := ResourceLoader.load(
		path, "", ResourceLoader.CACHE_MODE_REPLACE
	) as Script
	if script == null:
		push_warning(
			"WIRED_PACKAGE_ENTRY_INVALID package=%s path=%s reason=not_script"
			% [package_id, path]
		)
		return false
	var instance: Variant = script.new()
	if not (instance is WiredPackageRegistration):
		push_warning(
			"WIRED_PACKAGE_ENTRY_INVALID package=%s path=%s reason=not_registration"
			% [package_id, path]
		)
		return false
	var registration := instance as WiredPackageRegistration
	registration.package_id = package_id
	registration.context = context
	registration.register(registry)
	registry.add_registration(registration)
	registry.register_context(package_id, context)
	return true
