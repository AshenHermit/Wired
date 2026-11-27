extends WiredPackageRegistration

## Минимальный пример стороннего пакета для библиотеки `cura_registry`.
##
## Пакет ничего не знает о внутреннем устройстве ядра: он только объявляет
## категорию панели и динамический тип через публичный API. Бэкенд при
## публикации переписывает `res://packages/cura_registry/api.gd` на путь
## применённой ревизии библиотеки, поэтому исходник остаётся читаемым.
##
## Никаких `class_name` и прямых RPC: пакет только декларирует данные, а сетевые
## действия выполняются ядром через `register_action`/`request_action`.
## Идентификаторы локальны для пакета; реестр квалифицирует их как
## `pkg.crate/crate`.

const Cura = preload("res://tests/fixtures/cura_registry/api.gd")


func register(_registry: WiredPackageRegistry) -> void:
	Cura.register_category(self, "props", {"label": "Props", "order": 10})
	Cura.register_prop(self, "crate", "dynamic/crate.tscn", {
		"category": "props", "label": "Wooden crate", "authority": "server", "persist": true,
	})
