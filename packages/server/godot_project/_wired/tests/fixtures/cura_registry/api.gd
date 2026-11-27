extends RefCounted

## Публичный API библиотеки `cura_registry`.
##
## Пакеты подключают его как `const Cura := preload("api.gd")` и вызывают
## статические методы из своего `wired_package.gd`. Никаких `class_name` и
## прямых RPC: вся логика остаётся внутри пакета, а ядро получает только
## декларативные записи через `WiredPackageRegistration`.
##
## Идентификаторы категорий, инструментов и пропов локальны для пакета; реестр
## ядра квалифицирует их как `<package_id>/<id>`.

const DEFAULT_AUTHORITY := "server"
const KIND_CATEGORY := "cura.category"
const KIND_PROP := "cura.prop"
const KIND_TOOL := "cura.tool"


## Регистрирует категорию предметов/инструментов панели.
static func register_category(
	registration: WiredPackageRegistration,
	local_id: String,
	options: Dictionary = {}
) -> void:
	registration.add_custom(KIND_CATEGORY, local_id, options.duplicate(true))


## Регистрирует динамический проп и его пользовательский дескриптор.
##
## `add_dynamic_entity` создаёт запись, которую загружает `DynamicWorld`;
## `add_custom("cura.prop", ...)` несёт метаданные панели. Оба дескриптора
## связываются общим `dynamic_type == local_type`.
static func register_prop(
	registration: WiredPackageRegistration,
	local_type: String,
	scene_path: String,
	options: Dictionary = {}
) -> void:
	var authority := str(options.get("authority", DEFAULT_AUTHORITY))
	if authority.is_empty():
		authority = DEFAULT_AUTHORITY
	var persist := bool(options.get("persist", false))
	registration.add_dynamic_entity(
		local_type,
		scene_path,
		{"authority": authority, "persist": persist}
	)
	var meta := {
		"category": str(options.get("category", "")),
		"label": str(options.get("label", local_type)),
		"icon": str(options.get("icon", "")),
		"order": int(options.get("order", 0)),
		"tags": options.get("tags", []),
		"dynamic_type": local_type,
		"persist": persist,
	}
	registration.add_custom(KIND_PROP, local_type, meta)


## Регистрирует инструмент редактора/панели.
static func register_tool(
	registration: WiredPackageRegistration,
	local_id: String,
	options: Dictionary = {}
) -> void:
	registration.add_custom(KIND_TOOL, local_id, options.duplicate(true))


## Абсолютный путь к файлу пакета через применённый контекст ревизии.
##
## Возвращает пустую строку, если реестр или контекст пакета ещё не готов:
## пакет может вызвать helper до того, как движок применил ревизию.
static func resolve_path(package_id: String, relative_path: String) -> String:
	var registry := Global.get_package_registry()
	if registry == null:
		return ""
	var context := registry.get_context(package_id)
	if context == null:
		return ""
	return context.scene_path(relative_path)
