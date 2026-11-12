# godot_bake

Headless-инструмент, который превращает сырой `.glb` из пакета в самодостаточную
сцену `<asset>.glb.scn` ко времени сборки runtime-артефакта.

Зачем: экспортированная Godot-сборка не умеет импортировать glTF в рантайме.
`.glb` импортируется на этапе экспорта, а файл, скачанный в `user://`, загрузить
нечем — игра падает с `No loader found for resource`. Запекание решает это без
ручной работы автора пакета.

## Что лежит здесь

- `project.godot` — минимальный проект, в котором запускается инструмент.
- `bake_tool.gd` — `WiredBakeTool`: разбор заданий, запекание, применение пресета.
- `wired_bake.gd` — точка входа для `--script`.
- `tests/asset_bake_smoke.gd` — смоук-тест инструмента.
- `tests/inspect_bake.gd` — отчёт о содержимом запечённой сцены (для интеграционного теста).

## Запуск

```text
godot --headless --path <временный проект> --script res://wired_bake.gd -- <jobs.json>
```

Перед запуском в каталог проекта копируются `project.godot`, `bake_tool.gd`,
`wired_bake.gd` и файлы ревизии в `packages/<slug>/...`. Если у задания есть
пресет, проект сначала импортируется (`--headless --import`), иначе материалы
пресета, ссылающиеся на текстуры, не загрузятся.

### `jobs.json`

```json
{
  "jobs": [
    {
      "source": "packages/<slug>/player/dude.glb",
      "output": "packages/<slug>/player/dude.glb.scn",
      "preset": "[remap]\n\nimporter=\"scene\"\n\n[params]\n\n_subresources={...}"
    }
  ]
}
```

`preset` — нормализованный `.import`; пустая строка означает «пресета нет».

### Ответ

Одна строка в stdout:

- `WIRED_BAKE_OK {"results":[{"output":"...","size":123,"animations":["Idle"],"materials":["surface_a"],"warnings":[]}]}`
- `WIRED_BAKE_ERROR {"errors":[{"file":"...","reason":"gltf_import_failed","message":"..."}]}`

Код выхода `0` при успехе, `1` при ошибке. Одна сломанная модель не прерывает
остальные задания: инструмент собирает все ошибки и печатает их вместе.

## Пресет

Из `.import` берутся только два блока `_subresources`:

- `animations/<name>/settings/loop_mode` → `Animation.loop_mode`;
- `materials/<key>/use_external/{enabled,path,fallback_path}` → материал
  подставляется на поверхности, у которых `resource_name` совпадает с ключом.
  Приоритет у `fallback_path`: Godot пишет в `path` значение `uid://`, а во
  временном проекте кэша uid нет.

Внешние ресурсы (материалы и их текстуры) дублируются и сохраняются внутри
`.scn`: бинарную сцену нельзя переписать по путям позже.

## Тесты

```text
godot --headless --path packages/server/godot_bake --script res://tests/asset_bake_smoke.gd
```

Интеграционный тест на реальной модели (запускается из серверного набора):

```text
WIRED_GODOT_INTEGRATION=1 pnpm --filter server exec jest asset-bake.integration --runInBand
```

## Версии

Меняете `bake_tool.gd` или формат результата — увеличьте `BAKE_TOOL_VERSION`
и `ASSET_BAKE_VERSION` в `packages/server/src/scripting-packages/delivery/asset-bake.constants.ts`.
Первый сбрасывает кэш запечённых сцен, второй — ключи артефактов, чтобы старые
артефакты пересобрались.
