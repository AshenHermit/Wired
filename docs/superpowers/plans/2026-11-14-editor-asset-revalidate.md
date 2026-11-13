# Ревалидация ассетов редактора и базового проекта — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ассеты веб-редактора (`/api/godot-editor/*`) и файлы базового проекта (`/api/godot-project/wired/*`) получают `ETag` + `Cache-Control: no-cache` и отвечают 304 на `If-None-Match`; HTML-оболочка редактора остаётся `no-store`.

**Architecture:** Включаем уже существующий механизм `serveStaticAsset` (`src/common/static-assets.ts`): два вызова контроллера получают опции. Логика ETag/304/COOP-COEP уже там и покрыта тестами game-export, который ходит через тот же `/api`-рерайт — схема проверена end-to-end. Клиент и манифест `ProjectInfo` не меняются.

**Tech Stack:** NestJS 11, supertest, Jest (`packages/server`).

**Spec:** `docs/superpowers/specs/2026-11-14-editor-asset-revalidate-design.md`

## Global Constraints

- Меняются только `godot-editor-provider.controller.ts` (+ его spec) и статус дизайн-дока; `game-export.controller.ts` и его тесты не трогаем.
- `getGodotProjectFile` сохраняет `contentType: () => 'application/octet-stream'` и `crossOriginIsolation: false`; добавляется только `revalidate: true` — **без** `noStoreShell` (html внутри `_wired` — payload, обязан уметь 304).
- `getEditorFile` получает `{ revalidate: true, noStoreShell: true }` (как у game-export).
- Манифест `GET /godot-project/wired` остаётся без кеш-заголовков.
- Сжатие (gzip/brotli) и версионированные URL — вне объёма.
- Стиль сервера: Prettier — одинарные кавычки, висячие запятые; комментарии в коде — английские, в духе соседних.
- Conventional Commits.

## Review Focus

- `If-None-Match` со списком/слабой формой `W/"...", "stale"` → всё равно 304. Пин: слабая форма в тесте ассета редактора (Task 1).
- HTML-файл внутри `_wired` остаётся 304-able, никогда `no-store`. Пин: ассерты `index.html` в тесте файлов проекта (Task 1).
- Манифест не должен «случайно» обзавестись кеш-заголовками. Пин: ассерт `cache-control` undefined в существующем тесте манифеста (Task 1).
- Перезаливка редактора (`pnpm fetch:editor`) → новые ETag, одна полная перекачка, затем стабильно; js/wasm никогда не расходятся, т.к. всегда ревалидируются. Пин: no-cache+304 тест ассета редактора (Task 1).
- Поведение game-export не меняется. Пин: его существующие тесты, гоняются полным прогоном (Task 1, шаг верификации).

---

### Task 1: Ревалидация в `GodotEditorProviderController`

**Files:**
- Modify: `packages/server/src/godot-editor-provider/godot-editor-provider.controller.ts` (вызовы в `getEditorFile`, строки 37–42, и `getGodotProjectFile`, опции в строках 93–99)
- Test: `packages/server/src/godot-editor-provider/godot-editor-provider.controller.spec.ts`
- Modify: `docs/superpowers/specs/2026-11-14-editor-asset-revalidate-design.md` (строка 4: `Статус: на согласовании` → `Статус: одобрено`)

**Interfaces:**
- Consumes: `serveStaticAsset(root, relativePath, req, res, options)` из `src/common/static-assets.ts`; опция `revalidate: boolean` (ETag `"${size.toString(16)}-${mtimeSec.toString(16)}"`, `Cache-Control: no-cache`, 304 на `If-None-Match`), `noStoreShell: boolean` (`no-store` для `.html`/`.htm`).
- Produces: ничего (финальная задача); поведение эндпоинтов `GET /godot-editor/*path`, `GET /godot-project/wired/*filepath`.

- [x] **Step 1: Добавить фикстуры в `beforeAll` спека**

В `packages/server/src/godot-editor-provider/godot-editor-provider.controller.spec.ts`, в `beforeAll`, рядом с остальными `writeFile`:

```ts
    await writeFile(
      path.join(workspace, 'editor', 'godot.editor.html'),
      '<!doctype html><title>editor</title>',
    );
    await writeFile(path.join(projectPath, '_wired', 'index.html'), '<p>x</p>');
```

- [x] **Step 2: Написать failing-тесты в supertest-блоке `describe('HTTP wildcard routing')`**

Вставить после теста `serves the project manifest from the shared route` (перед закрывающим `});` блока в строке 173). По образцу `game-export.controller.spec.ts:95-116`:

```ts
    it('revalidates editor assets instead of re-downloading the 67 MB wasm', async () => {
      const app = await createApp();

      try {
        const first = await request(app.getHttpServer())
          .get('/godot-editor/engine.js')
          .expect(200);
        expect(first.headers['cache-control']).toBe('no-cache');
        expect(first.headers.etag).toBeDefined();

        await request(app.getHttpServer())
          .get('/godot-editor/engine.js')
          .set('If-None-Match', first.headers.etag)
          .expect(304);

        await request(app.getHttpServer())
          .get('/godot-editor/engine.js')
          .set('If-None-Match', `W/${first.headers.etag}, "stale"`)
          .expect(304);
      } finally {
        await app.close();
      }
    });

    it('keeps the standalone editor shell out of the cache', async () => {
      const app = await createApp();

      try {
        const response = await request(app.getHttpServer())
          .get('/godot-editor/godot.editor.html')
          .expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
      } finally {
        await app.close();
      }
    });

    it('revalidates base project files, including html payloads', async () => {
      const app = await createApp();

      try {
        for (const file of ['project.godot', 'index.html']) {
          const first = await request(app.getHttpServer())
            .get(`/${GODOT_PROJECT_ROUTE}/${file}`)
            .expect(200);
          expect(first.headers['cache-control']).toBe('no-cache');
          expect(first.headers.etag).toBeDefined();

          await request(app.getHttpServer())
            .get(`/${GODOT_PROJECT_ROUTE}/${file}`)
            .set('If-None-Match', first.headers.etag)
            .expect(304);
        }
      } finally {
        await app.close();
      }
    });
```

В существующем тесте `serves the project manifest from the shared route`, сразу после `.expect(200)` (строка 158), добавить пин «манифест не кешируется»:

```ts
        expect(response.headers['cache-control']).toBeUndefined();
```

- [x] **Step 3: Прогнать тесты, убедиться, что новые падают**

Run: `pnpm --filter server exec jest godot-editor-provider`
Expected: FAIL — три новых теста падают (`cache-control`/`etag` undefined вместо значений, 200 вместо 304); старые зелёные.

- [x] **Step 4: Включить опции в контроллере**

`packages/server/src/godot-editor-provider/godot-editor-provider.controller.ts`, `getEditorFile` — добавить пятый аргумент:

```ts
    return serveStaticAsset(
      resolve(this.configService.godot.editorPath),
      wildcardPath(requestedPath),
      req,
      res,
      // js/wasm must always revalidate so a cached script never pairs with a
      // new engine build; the standalone shell page stays no-store.
      { revalidate: true, noStoreShell: true },
    );
```

`getGodotProjectFile` — в существующий объект опций добавить `revalidate: true`:

```ts
      {
        // The editor writes these into its own file system, so the browser
        // never has to interpret them.
        contentType: () => 'application/octet-stream',
        // Not document responses: isolation headers would only add noise.
        crossOriginIsolation: false,
        // There is no shell in the project tree: every file is a payload the
        // editor FS fetches, so revalidate — never no-store.
        revalidate: true,
      },
```

- [x] **Step 5: Прогнать тесты, убедиться, что всё зелёное**

Run: `pnpm --filter server exec jest godot-editor-provider`
Expected: PASS — все тесты файла, включая три новых и пин манифеста.

- [x] **Step 6: Полная верификация**

Run: `pnpm --filter server test && pnpm --filter server check-types && pnpm --filter server lint`
Expected: тесты все зелёные (в т.ч. game-export — без изменений), typecheck чист, lint без ошибок.

- [x] **Step 7: Обновить статус дизайн-дока и закоммитить**

В `docs/superpowers/specs/2026-11-14-editor-asset-revalidate-design.md`: `Статус: на согласовании` → `Статус: одобрено`.

```bash
git add packages/server/src/godot-editor-provider/godot-editor-provider.controller.ts packages/server/src/godot-editor-provider/godot-editor-provider.controller.spec.ts docs/superpowers/specs/2026-11-14-editor-asset-revalidate-design.md
git commit -m "perf(server): revalidate editor and base project assets via ETag/304"
```

**Ручная проверка (после внедрения, вне задачи):** открыть редактор дважды — в Network у wasm/js и файлов проекта 304 или «из кеша», без перекачки 67 МБ.
