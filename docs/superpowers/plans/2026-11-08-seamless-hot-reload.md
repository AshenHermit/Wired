# Бесшовная двухфазная замена мира — план реализации

> **Для агентских исполнителей:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (рекомендуется) or superpowers:executing-plans для реализации этого плана по задачам. Шаги используют чекбоксы (`- [ ]`) для отслеживания.

**Цель:** заменить текущий hot reload, при котором физические объекты временно исчезают, на двухфазную подготовку и короткий commit без провала игроков.

**Архитектура:** новая ревизия сначала загружается и регистрируется в существующем package pipeline. StaticWorldContainer и DynamicWorldContainer подготавливают новые узлы, сохраняя старый активный слой до commit; MainScene координирует commit под текущим hot-reload barrier. После появления новых коллайдеров старый слой удаляется, а состояние игроков и динамических сущностей восстанавливается.

**Стек:** Godot 4.8-beta2 GDScript, MultiplayerSpawner, существующие smoke-тесты в `packages/server/godot_project/_wired/tests`, Jest/Vitest только если потребуется проверить контракт вне Godot.

**Спецификация:** `docs/superpowers/specs/2026-11-08-seamless-hot-reload-design.md`

## Глобальные ограничения

- Сохранять сетевые `entity_id`, persisted state и текущий snapshot/late-join контракт.
- Не менять backend API, package manifest или порядок загрузки/проверки артефактов.
- Не удалять старую рабочую версию до успешной подготовки новой.
- Не допускать одновременного interleave package operations: использовать существующую очередь `_package_ops_queue`.
- Сохранять существующий `hot_reload_barrier` для server/client согласования.
- Не менять legacy game-room/API совместимость и не добавлять зависимости.

## Фокус проверки

- Ошибка инстанцирования новой static-сцены: старый слой остаётся активным, новая ревизия не коммитится — тест в задаче 1.
- Пакет без static entries: commit не должен очищать статический мир других пакетов — тест в задаче 1.
- Несколько package reload подряд: операции сериализуются и не оставляют старые staged-слои — тест в задаче 3.
- Динамическая сущность с `persist: false`: во время reload сохраняется для текущего мира, но не попадает в save-файл — тест в задаче 2.
- Ошибка/частичный client apply: клиент не должен самовольно считать staged entity authoritative; snapshot/barrier остаются источником истины — тест в задаче 3.

---

### Задача 1: Staged static world

**Файлы:**
- Изменить: `packages/server/godot_project/_wired/_wired/scripts/world/static_world_container.gd`
- Тесты: `packages/server/godot_project/_wired/tests/static_world_smoke.gd`, при необходимости добавить fixture-сцену в `packages/server/godot_project/_wired/tests/fixtures/`

**Интерфейсы:**
- Производит `prepare_rebuild() -> Dictionary` с подготовленным набором registry-owned roots и `commit_prepared(prepared: Dictionary) -> bool`.
- Производит `discard_prepared(prepared: Dictionary) -> void` для rollback.
- Сохраняет `rebuild() -> void` как совместимый wrapper для startup/не-hot-reload вызовов.

- [ ] **Шаг 1: Написать failing smoke-тест подготовки и commit**
  - Создать два зарегистрированных static root с коллайдерами.
  - Вызвать `prepare_rebuild()` и проверить, что старый root всё ещё находится в дереве, а новый подготовлен.
  - Вызвать `commit_prepared()` и проверить наличие нового root, отсутствие старого и отсутствие дублирования.
  - Проверить, что ошибка инстанцирования приводит к `discard_prepared()` и оставляет старый root.
  - Проверить, что `clear()`/rebuild одного package не удаляет authored nodes и registry roots других package.

- [ ] **Шаг 2: Запустить smoke-тест и убедиться, что он падает на отсутствующем staged API**
  - Запуск: `pnpm --filter server exec jest` не подходит для GDScript; использовать существующий Godot smoke harness из проекта или команду, принятую для `_wired/tests`.
  - Ожидание: FAIL до реализации, без изменения production-кода.

- [ ] **Шаг 3: Реализовать staged API в `static_world_container.gd`**
  - Инстанцировать новые roots в отдельном временном контейнере/наборе, не вызывая `queue_free()` у старых.
  - Валидировать результат подготовки; при null/ошибке вернуть невалидный prepared result.
  - В `commit_prepared()` добавить новый набор в дерево/активный контейнер, удалить старый набор только после добавления новых узлов и очистить staging metadata.
  - Реализовать rollback без изменения старого active layer.
  - Оставить deterministic registry order и spawn-marker поведение без изменений.

- [ ] **Шаг 4: Запустить targeted smoke-тест и убедиться, что он проходит**
  - Ожидание: PASS для успешного commit, rollback и независимых package roots.

- [ ] **Шаг 5: Commit**
  - `git add packages/server/godot_project/_wired/_wired/scripts/world/static_world_container.gd packages/server/godot_project/_wired/tests`
  - `git commit -m "feat: stage static world during package reload"`

### Задача 2: Staged dynamic entities

**Файлы:**
- Изменить: `packages/server/godot_project/_wired/_wired/scripts/world/dynamic_world_container.gd`
- Тесты: `packages/server/godot_project/_wired/tests/dynamic_world_smoke.gd`, `packages/server/godot_project/_wired/tests/state_persistence_smoke.gd`

**Интерфейсы:**
- Производит `prepare_package_reload(package_id: int) -> Dictionary` с копиями records и staged entities.
- Производит `commit_package_reload(prepared: Dictionary) -> bool`.
- Производит `discard_package_reload(prepared: Dictionary) -> void`.
- Существующие `park_package`, `drop_package`, `restore_pending`, `save_state`, `snapshot_state` остаются совместимыми для startup/remove paths.

- [ ] **Шаг 1: Написать failing тесты динамической замены**
  - Зафиксировать исходный `entity_id`, type, transform/state и owner.
  - Подготовить reload и проверить, что старый entity остаётся активным до commit.
  - После commit проверить тот же `entity_id`, восстановленный state и отсутствие старого экземпляра.
  - Проверить `persist: false`: entity существует в текущем мире после commit, но не добавляется в `save_state()`.
  - Проверить rollback: старый entity и индекс остаются единственными активными записями.

- [ ] **Шаг 2: Запустить targeted тесты и убедиться, что они падают**
  - Ожидание: FAIL на отсутствующем staged API или несоответствующем lifecycle.

- [ ] **Шаг 3: Реализовать staged replacement**
  - Снять persisted-shape record через `_wired_save_state()` до создания новой версии.
  - Подготовить новую entity через текущий registry/spawner path, но не терять `entity_id` и не публиковать промежуточный snapshot.
  - В commit атомарно обновить `_entities`, `_parked` и `_restored_ids`; старые nodes освобождать только после успешного добавления новых.
  - При невозможности создать хотя бы одну обязательную entity выполнить discard и сохранить старую коллекцию.
  - Не включать transient `spawn_data` и не менять правила save/snapshot для non-persistent entities.

- [ ] **Шаг 4: Запустить targeted тесты и убедиться, что они проходят**
  - Ожидание: PASS для ID/state/persistence/rollback.

- [ ] **Шаг 5: Commit**
  - `git add packages/server/godot_project/_wired/_wired/scripts/world/dynamic_world_container.gd packages/server/godot_project/_wired/tests`
  - `git commit -m "feat: stage dynamic entities during package reload"`

### Задача 3: Координация двух фаз в MainScene

**Файлы:**
- Изменить: `packages/server/godot_project/_wired/_wired/scripts/main_scene.gd`
- Изменить при необходимости: `packages/server/godot_project/_wired/_wired/scripts/players/wired_player.gd`, `packages/server/godot_project/_wired/_wired/scripts/global/players_manager.gd`
- Тесты: `packages/server/godot_project/_wired/tests/main_scene_swap_smoke.gd`, `packages/server/godot_project/_wired/tests/late_join_smoke.gd`, `packages/server/godot_project/_wired/tests/network_readiness_smoke.gd`

**Интерфейсы:**
- Внутренний orchestration method: `_prepare_registered_package(package_id: int, revision: int) -> Dictionary`.
- Внутренний commit method: `_commit_registered_package(prepared: Dictionary) -> bool`.
- Внутренний rollback method: `_discard_registered_package(prepared: Dictionary) -> void`.
- Existing `_apply_registered_package(package_id: int, revision: int) -> void` становится coordinator-ом этих фаз и сохраняет текущие signal/barrier semantics.

- [ ] **Шаг 1: Написать failing integration smoke-тест**
  - Запустить reload пакета с ground/box static content и player, стоящим на collider.
  - В момент подготовки проверить, что старый collider существует.
  - После commit проверить, что новый collider существует, player не получил падение из-за пустого physics window, а entity IDs/state совпадают.
  - Проверить, что следующая package operation ждёт завершения первой.
  - Проверить late join/snapshot после commit: клиент получает только committed revision и актуальные entities.

- [ ] **Шаг 2: Запустить integration smoke-тест и убедиться, что он падает на старом park → rebuild → restore порядке**
  - Ожидание: FAIL либо по пустому окну мира, либо по отсутствующему coordinator API.

- [ ] **Шаг 3: Реализовать coordinator в `main_scene.gd`**
  - Сохранить текущую загрузку/registry registration и вызвать staged prepare после загрузки новой ревизии.
  - Не вызывать `park_package()`/`static_world.rebuild()` до успешной подготовки обоих слоёв.
  - На server использовать staged dynamic records; на client подготовить локальные copies только в рамках текущего barrier, не выдавая их за authoritative snapshot.
  - Перед commit сохранить player transform и необходимые velocity/physics параметры; выполнить commit static + dynamic; затем восстановить player state и обновить live components.
  - После commit отправить/разрешить существующий snapshot/barrier flow; при ошибке вызвать discard и оставить старую registry/world state.
  - `package_applied` и package queue должны оставаться сериализованными; новый commit не должен interleave с `_pending_world_snapshot`.

- [ ] **Шаг 4: Добавить/обновить player state seam**
  - В `wired_player.gd`/`players_manager.gd` определить компактный state record для transform, linear velocity и rotation/направления.
  - Снимок делать перед commit, восстановление — после появления новых colliders; не изменять обычное движение вне reload.

- [ ] **Шаг 5: Запустить все Godot smoke-тесты, связанные с reload/network**
  - Ожидание: PASS для main scene swap, late join, network readiness, dynamic world и state persistence.

- [ ] **Шаг 6: Commit**
  - `git add packages/server/godot_project/_wired/_wired/scripts/main_scene.gd packages/server/godot_project/_wired/_wired/scripts/players packages/server/godot_project/_wired/tests`
  - `git commit -m "feat: coordinate two-phase package world reload"`

### Задача 4: Полная верификация и регрессии

**Файлы:**
- Изменить только при обнаружении регрессии: соответствующие smoke tests или GDScript files.

- [ ] **Шаг 1: Запустить server typecheck и тесты**
  - `pnpm --filter server check-types`
  - `pnpm --filter server test`
  - Ожидание: оба процесса завершаются успешно.

- [ ] **Шаг 2: Запустить frontend проверки, если затронуты общие контракты**
  - `pnpm check-types:frontend`
  - `pnpm --filter frontend test`
  - Ожидание: PASS; если TypeScript-контракт не менялся, зафиксировать, что frontend изменения отсутствуют.

- [ ] **Шаг 3: Запустить полный Godot smoke/integration набор**
  - Использовать существующий проектный harness для `_wired/tests`; отдельно включить `WIRED_GODOT_INTEGRATION=1` только если доступны runtime и templates.
  - Проверить успешный hot reload, rollback, late join и повторные reload.

- [ ] **Шаг 4: Проверить diff и рабочее дерево**
  - `git diff --check`
  - `git status --short`
  - Убедиться, что не добавлены generated Godot artifacts (`godot_runtime`, `game_export`, `.godot`, storage).

- [ ] **Шаг 5: Commit финальных регрессионных исправлений**, если они потребовались
  - `git add ...`
  - `git commit -m "test: verify seamless hot reload"`
