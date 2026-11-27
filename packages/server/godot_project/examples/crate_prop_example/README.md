# Пример пакета: `crate_prop_example`

Минимальный пример того, как сторонний пакет вызывает публичный API библиотеки
`cura_registry` из своего `wired_package.gd` и регистрирует спавнимый проп.

```text
crate_prop_example/
  wired_package.gd       # точка входа: категория + проп через `Cura`
  dynamic/crate.tscn     # RigidBody3D, скрипт `extends WiredDynamicEntity`
```

Точка входа:

```gdscript
extends WiredPackageRegistration

const Cura = preload("res://packages/cura_registry/api.gd")

func register(_registry: WiredPackageRegistry) -> void:
	Cura.register_category(self, "props", {"label": "Props", "order": 10})
	Cura.register_prop(self, "crate", "dynamic/crate.tscn", {
		"category": "props", "label": "Wooden crate", "authority": "server", "persist": true,
	})
```

Путь `res://packages/cura_registry/api.gd` при публикации переписывается бэкендом
на путь применённой ревизии библиотеки. Скрипт пакета не объявляет `class_name` и
не использует прямые RPC: ядро получает только декларативные записи.
Локальные id квалифицируются реестром как `<package_id>/<id>`, например
`pkg.crate/crate` — именно этот тип спавнит встроенный инструмент `spawner`.

Корень `dynamic/crate.tscn` — `RigidBody3D` с массой 1, `BoxShape3D` в
`CollisionShape3D` и кубом `BoxMesh` в `MeshInstance3D`. Скрипт сцены
наследует `WiredDynamicEntity`, поэтому ядро спавнит ящик серверно и
реплицирует его состояние.

Чтобы попробовать: создайте пакет в комнате, скопируйте содержимое этого
каталога в `packages/<slug>/` редактора и нажмите **Emit**. Затем выберите
проп `crate` в панели `cura_registry` и спавните его инструментом `spawner`.
