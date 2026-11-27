extends WiredPackageRegistration

## Entry библиотеки `cura_registry`.
##
## Библиотека регистрирует категории панели, встроенный инструмент `spawner`,
## локальную панель Q и серверный менеджер инструментов. Пользовательские записи
## объявляются только через `Cura.*`, компоненты игрока — через
## `add_player_component`. Идентификаторы локальны для пакета: ядро квалифицирует
## их как `<package_id>/<id>`.
##
## Никаких `class_name` и прямых RPC: сетевые действия компоненты выполняют через
## `register_action`/`request_action`, вся логика остаётся внутри пакета.

const Cura = preload("res://tests/fixtures/cura_registry/api.gd")


func register(_registry: WiredPackageRegistry) -> void:
	Cura.register_category(self, "props", {"label": "Props", "order": 10})
	Cura.register_category(self, "tools", {"label": "Tools", "order": 20})
	Cura.register_tool(
		self,
		"spawner",
		{"label": "Toolgun", "category": "tools", "order": 20},
	)
	add_player_component(
		"ui/registry_panel.tscn",
		{"order": 40, "authority": "local", "local_only": true},
	)
	add_player_component("tools/tool_manager.tscn", {"order": 50, "authority": "server"})
	add_player_component("tools/spawner.tscn", {"order": 60, "authority": "server"})
