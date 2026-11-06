# Дизайн: перетаскиваемая панель Editor/Packages/Game и меню действий пакета

Дата: 2026-11-02
Статус: на утверждении
Область: `frontend/src/app/room/[room_code]/(godot)/RoomPageClient.tsx`, `PackagesTab.tsx`, новые компоненты/хук в той же папке

## 1. Задача

1. Панель табов **Editor / Packages / Game** сейчас жёстко стоит в `absolute top-0 left-[52%] z-10`. Нужно:
   - перетаскивать её за отдельный видимый грип (`GripVertical`) слева от табов;
   - не давать панели выходить за края окна (в том числе после ресайза);
   - сохранять позицию в браузере и восстанавливать при следующей загрузке.
2. В карточке пакета вкладки Packages убрать четыре второстепенные кнопки — «Скачать в редактор», «Убрать из редактора», «Отключить/Включить», «Удалить из комнаты» — в меню-кнопку с dropdown-menu из animate-ui.
   - «Emit» и «Использовать каталог» остаются видимыми как основные действия.

## 2. Цели

- Грип — единственная зона захвата; табы и их клики не меняются.
- Позиция панели переживает перезагрузку страницы, общая для браузера (не per-room).
- Панель всегда целиком видна в viewport.
- Меню пакета использует animate-ui `dropdown-menu` (radix), доступно с клавиатуры, сохраняет текущие disabled-состояния и подтверждения.
- Существующие тесты вкладки Packages остаются зелёными; добавляется тест на кламп позиции.

## 3. Не-цели

- Снэп к краям/сетке, инерция, изменение размера панели, мультиоконная синхронизация.
- Серверное хранение позиции, per-room позиции.
- Изменение API, DTO, `packages/shared`.
- Редизайн карточки пакета сверх переноса перечисленных кнопок.

## 4. Ограничения и факты проекта

- Панель — `TabsList` из `@/components/animate-ui/components/animate/tabs`; у неё уже есть `data-slot="tabs-list"` и подсветка. Грип не встраиваем внутрь `role="tablist"`, а ставим отдельной кнопкой-соседом в общем контейнере, чтобы не ломать семантику табов.
- `RoomPageClient` — клиентский компонент, контейнер `relative w-screen h-screen`. Панель переводим на `fixed`, координаты — в пикселях viewport.
- В проекте нет библиотеки drag-and-drop и нет готового `dropdown-menu`; animate-ui реестр уже подключён в `components.json` (`@animate-ui` → `https://animate-ui.com/r/{name}.json`).
- Пакет `radix-ui` и `motion` уже в зависимостях, поэтому animate-ui dropdown не требует новых npm-пакетов. Дополнительно нужен отсутствующий хук `use-data-state` из animate-ui.
- Хук перетаскивания опирается на Pointer Events + `setPointerCapture`, `touch-action: none` на грипе.
- Тесты frontend — Vitest + jsdom + Testing Library; `@testing-library/user-event` не установлен.

## 5. Рассмотренные подходы

| Подход | Плюсы | Минусы | Решение |
|---|---|---|---|
| Свой хук на pointer events + `localStorage` | Без зависимостей, полный контроль, легко тестировать кламп | Нужно аккуратно сделать кламп/ресайз | **Выбран** |
| `react-rnd` / `dnd-kit` | Готовые снэп/инерция | Новая зависимость ради одной панели, лишний вес | Отклонён |
| Нативный HTML5 drag | Мало кода | Плохой тач, конфликт с кликами | Отклонён |

Для меню выбран animate-ui `dropdown-menu` (radix-примитив + обёртка), потому что это уже принятый в проекте стиль анимаций; shadcn `context-menu` семантически про правый клик.

## 6. Перетаскиваемая панель

### 6.1 Структура

В `RoomPageClient.tsx` вокруг `TabsList` появляется `fixed z-10` контейнер:

```
<div ref={panelRef} className="fixed z-10 flex h-9 items-center gap-1" style={{ transform: `translate3d(${x}px, ${y}px, 0)` }}>
  <button ref={gripRef} aria-label="Перетащить панель" className="... cursor-grab active:cursor-grabbing touch-none ...">
    <GripVerticalIcon />
  </button>
  <TabsList>…</TabsList>
</div>
```

- Начальная позиция (нет сохранённой): `x = 0.52 * innerWidth`, `y = 0` — эквивалент текущего `left-[52%] top-0`.
- Грип стилизован под высоту таб-бара (`h-9`, `rounded-md`, `bg-muted`), с hover/focus как у кнопок.

### 6.2 Хук `use-draggable-panel`

Новый файл `frontend/src/app/room/[room_code]/(godot)/use-draggable-panel.ts`:

- `useDraggablePanel(options: { initialX?: (vw: number) => number; initialY?: number; storageKey: string; margin?: number })`
  возвращает `{ panelRef, gripRef, style, isDragging }`.
- `pointerdown` на грипе: `setPointerCapture`, запоминаем `pointerId`, стартовые `clientX/clientY` и `x/y`, `preventDefault()`.
- `pointermove`: `next = start + (client - startClient)`, затем кламп.
- `pointerup` / `pointercancel`: снимаем capture, сохраняем `{x, y}` в `localStorage`, сбрасываем `isDragging`.
- `pointermove`/`pointerup` навешиваются на грип (pointer capture перенаправляет события на него), без глобальных `window`-листенеров.
- `resize` окна: пересчитываем кламп по актуальным размерам панели (`getBoundingClientRect`) и окна; клампнутое значение сохраняем.
- Монтирование: читаем `localStorage`; при отсутствии/битом JSON — начальная позиция; битые данные удаляем.
- Ключ хранения: `wired.room-tabs.position.v1`, значение `{"x":number,"y":number}`.
- Гидрация Next.js: начальное состояние `null`, позиция вычисляется в `useLayoutEffect` после монтирования, чтобы не было SSR-мисматча и вспышки в углу. До вычисления контейнер рендерится с `visibility: hidden`.
- Доступность: грип — `<button type="button">` с `aria-label="Перетащить панель"` и `title`; клавиатурное перемещение стрелками (шаг 10px, с Shift — 1px) — опционально, добавляем, т.к. стоит дёшево и не конфликтует с drag.

Экспортируемая чистая функция `clampPanelPosition({ x, y, panel, viewport, margin })` — единственное место с математикой клампа; покрывается юнит-тестом.

### 6.3 Поведение

- Панель не может выйти за края: `0 ≤ x ≤ viewport.width - panel.width`, `0 ≤ y ≤ viewport.height - panel.height` (с опциональным `margin`, по умолчанию 0).
- Если панель шире окна, `x = 0`.
- Сохранённая позиция при загрузке тоже клампится (окно могло измениться).
- Перетаскивание не влияет на активный таб: грип — отдельная кнопка, drag не начинается на табах.

## 7. Меню действий пакета

### 7.1 Новые файлы animate-ui

- `frontend/src/components/animate-ui/primitives/radix/dropdown-menu.tsx`
- `frontend/src/components/animate-ui/components/radix/dropdown-menu.tsx`
- `frontend/src/hooks/use-data-state.tsx` (зависимость примитива)
- При необходимости — `frontend/src/hooks/use-controlled-state.tsx` уже есть; импорты не дублируем.

Ставим через shadcn CLI (`pnpm dlx shadcn@latest add @animate-ui/components-radix-dropdown-menu`) либо вручную копируем те же файлы из реестра, если CLI не разрешит `@animate-ui/v1/*`-зависимость. Форматирование — как у сгенерированных animate-ui файлов.

### 7.2 `PackageCard`

- Справа остаются: «Использовать каталог» (если применимо), «Emit» (если `enabled`), затем `Button variant="ghost" size="icon"` с `MoreHorizontalIcon` и `aria-label="Действия с пакетом"`.
- В `DropdownMenuContent align="end"` пункты в порядке:
  1. «Скачать в редактор» (`DownloadIcon`) — disabled при `!fsReady || busy || publishedRevision === null`;
  2. «Убрать из редактора» (`Trash2Icon`) — только если `entry.inEditor`, disabled при `!fsReady || busy`;
  3. «Отключить» / «Включить» (`PowerIcon`) — disabled при `!fsReady || busy`;
  4. разделитель;
  5. «Удалить из комнаты» (`Trash2Icon`) — красный текст, disabled при `!fsReady || busy`.
- Пункты вызывают те же обработчики, что и раньше (`onDownload`, `onRemove`, `onToggle`, `onDelete`), подтверждения остаются прежними.
- `title`-подсказки переезжают в текст пунктов; для disabled-случаев сохраняем пояснение через `DropdownMenuLabel`/`disabled` без нативных title.
- Меню закрывается после выбора пункта (поведение radix по умолчанию).

## 8. Тесты

- Новый `use-draggable-panel.test.ts`: чистая функция клампа (внутри границ, за левым/правым/верхним/нижним краем, панель шире окна).
- `PackagesTab.test.tsx`: перед кликом по пунктам меню открывать его (`fireEvent.pointerDown` по кнопке «Действия с пакетом» + `findByRole("menuitem", …)`), затем кликать пункт; проверки подтверждающих диалогов и вызовов контроллера сохраняются. Проверка, что «Emit» остаётся видимой кнопкой, добавляется.
- `RoomPageClient` отдельного теста не имеет и не получает: поведение покрыто чистым клампом и ручной проверкой.

## 9. Проверка

- `pnpm check-types:frontend`
- `pnpm --filter frontend lint`
- `pnpm --filter frontend test` (или целевые файлы)
- Ручная проверка в браузере: перетащить панель в каждый угол, обновить страницу, сузить окно, проверить меню и все четыре действия.

## 10. Что остаётся на усмотрение реализатора

- Точные Tailwind-классы грипа и hover/focus-стили.
- Порядок и иконки пунктов меню, если визуально лучше сгруппировать иначе.
- Добавлять ли клавиатурное перемещение стрелками (по умолчанию — да).
