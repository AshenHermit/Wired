# Начало работы с пакетами Wired

Wired строится вокруг **пакетов комнаты** (room packages): набора сцен и скриптов,
которые публикуются в конкретную комнату и доставляются всем её клиентам
в виде проверенного артефакта. Весь сетевой код при этом пишет ядро `_wired`,
а пакет лишь регистрирует контент.

## Что такое пакет

Пакет — это каталог в файловой системе редактора Godot, лежащий по пути
`res://packages/<slug>/`. В корне каталога обязательно находится файл
`wired_package.gd` — точка входа пакета. Остальные файлы (сцены, скрипты,
ресурсы) располагаются в подкаталогах, и все пути в регистрации указываются
**относительно корня пакета**.

Минимальный пакет:

```
packages/<slug>/
  wired_package.gd
  static/
    platform.tscn
  player/
    body.tscn
  dynamic/
    crate.tscn
  ui/
    custom_main.tscn
```

## Точка входа: `wired_package.gd`

Скрипт должен наследовать `WiredPackageRegistration` и не объявлять `class_name`.
Ядро загружает его через `PackageEntryLoader` с `CACHE_MODE_REPLACE`, создаёт
экземпляр и вызывает `register(registry)`.

```gdscript
extends WiredPackageRegistration

func register(_registry: WiredPackageRegistry) -> void:
    add_main_scene("ui/custom_main.tscn")
    add_static_scene("static/platform.tscn", {"order": 10})
    add_player_component("player/body.tscn", {"order": 10, "authority": "server"})
    add_player_component(
        "player/camera.tscn",
        {"order": 20, "authority": "local", "local_only": true}
    )
    add_dynamic_entity(
        "crate", "dynamic/crate.tscn", {"authority": "server", "persist": true}
    )
```

Все пути относительны корня пакета, поэтому каталог можно копировать в
`res://packages/<slug>` без правок. Скрипты пакета не используют RPC: вся
сетевая логика идёт через ядро `_wired`.

## Порядок регистрации

Регистрация — это сбор дескрипторов. Реестр (`WiredPackageRegistry`) сортирует
их по `package_id`, затем по `order`, затем по индексу регистрации. Поэтому:

- `order` управляет очередностью внутри одного пакета (тело игрока — 10,
  камера — 20, спавнер — 30);
- динамические сущности не имеют `order` (он равен 0);
- первая main-сцена в порядке реестра побеждает.

## Публикация пакета в комнату

1. Откройте вкладку **Packages**.
2. Нажмите **Создать пакет**, заполните имя, версию и **slug** (строчные
   латинские буквы, цифры и `_`, например `wired_platformer`). В карточке
   появится slug вида `#<slug>`, а в редакторе — пустой каталог
   `packages/<slug>`.
3. Скопируйте содержимое примера (например `wired-platformer`) в
   `packages/<slug>/` в файловой системе редактора, сохранив структуру
   каталогов. Если пакет уже публиковался — сначала **Скачать в редактор**.
4. Нажмите **Emit** в карточке пакета. Runtime комнаты применит ревизию и
   разошлёт её клиентам.
5. Откройте вкладку **Game** в двух окнах. Первый запуск runtime и
   синхронизация занимают несколько секунд.

## Ограничения

- Горячая замена пересобирает статику, но не пересобирает уже заспавненных
  игроков: для новых компонентов нужен reconnect.
- `MultiplayerSpawner`/`MultiplayerSynchronizer` Godot 4.7 реплицируют данные
  на транспортном уровне и не фильтруются ticket-аутентификацией.
- Пакет без `wired_package.gd` валиден и просто не вносит контент.

## См. также

- [Регистрация сущностей](entity-registration.md)
- [Справочник API](api-reference.md)
- [Сетевое руководство](multiplayer-guide.md)
