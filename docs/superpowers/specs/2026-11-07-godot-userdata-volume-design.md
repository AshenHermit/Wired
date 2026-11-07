# Godot userdata on wired_storage

## Intent

После recreate backend-контейнера состояние комнат и кэш Godot `user://` не должны пропадать. Пользователь выбрал: перенаправить `XDG_DATA_HOME` на уже существующий volume `wired_storage`.

## Goals

- Godot `user://` (пакетный кэш комнат под `user://wired/rooms/...`) переживает `compose up --force-recreate` и пересборку образа.
- Не добавлять новый named volume.
- Не ломать уже настроенный путь `GODOT_ROOM_STATE_DIR=/app/storage/godot_rooms` → `state.json`.

## Non-goals

- Миграция данных из старого `/opt/godot-data` на проде (если там что-то накопилось — после деплоя кэш просто перекачается).
- Отдельный volume только под userdata.
- Менять схему `state.json` или логику сохранения в GDScript.

## Anti-goals

- Потерять bake export-templates в образе: шаблоны нужны на build-stage; runtime их не читает из `XDG_DATA_HOME`.
- Сломать cwd/path резолв сервера (`WORKDIR /app/packages/server`).

## Constraints

- Compose уже монтирует `wired_storage` → `/app/storage` и задаёт `GODOT_ROOM_STATE_DIR=/app/storage/godot_rooms`.
- `backend.Dockerfile` задаёт `XDG_DATA_HOME=/opt/godot-data` (наследуется final); env в compose перекрывает значение для процесса контейнера.
- `RoomRuntimeConfiguration.buildRuntimeEnv` пробрасывает `XDG_DATA_HOME` в дочерний Godot — достаточно выставить переменную на сервисе `backend`.
- Имя проекта Godot: `wired-instance-project` (`project.godot` `config/name`).

## Approaches

1. **Redirect `XDG_DATA_HOME` на `/app/storage/godot-data`** (выбрано) — один volume, минимум изменений.
2. Отдельный named volume на `/opt/godot-data` — чище изоляция, лишний volume.
3. Монтировать только `app_userdata/wired-instance-project` — хрупко к имени проекта/пути Godot.

Выбран подход 1, потому что storage уже персистентный и деплой/prune не трогают его отдельно от userdata.

## How

1. В `docker-compose.yml` у `backend.environment` добавить:
   - `XDG_DATA_HOME=/app/storage/godot-data`
2. Коротко обновить `AGENTS.md` (факт про persistence userdata через storage volume).
3. При желании — одна строка в `.env.prod.example`/деплой-доках, что переменная задаётся compose, не секретом.

Код Nest/Godot не обязателен: allowlist env уже есть. Builder call: не создавать каталог заранее — Godot/`DirAccess` сами создают дерево под `user://`; volume writable.

## Verification

- После деплоя в контейнере: `echo $XDG_DATA_HOME` → `/app/storage/godot-data`.
- Поднять комнату, дождаться применения пакетов, остановить backend (`compose stop backend` / recreate), поднять снова — каталог `/app/storage/godot-data/.../app_userdata/wired-instance-project/wired/rooms/<id>/` на месте; `state.json` в `/app/storage/godot_rooms/<id>/` на месте.
- Мир комнаты восстанавливается без «пустого» старта из-за отсутствующего userdata.

## Left to the builder

- Точная формулировка комментария в compose рядом с env.
- Нужен ли тест на allowlist/`XDG_DATA_HOME` в spawn env (опционально; поведение уже покрыто конфигурацией allowlist).
