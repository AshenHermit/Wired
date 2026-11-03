# Frontend file naming and placement

The frontend is a Next.js App Router project with two route groups:
`(browser)` for the public site and `room/[room_code]` for the editor. Both hold
app-authored code next to route files, so the rules below decide where a new
module goes and what it is called.

## File name follows the export

| What the file exports                | Name                     | Example                                  |
| ------------------------------------ | ------------------------ | ---------------------------------------- |
| A React component                    | `PascalCase.tsx`, same as the component | `PackagesTab.tsx` → `PackagesTab`        |
| A React hook                         | `use-thing.ts` (`kebab-case` after `use-`) | `use-room-packages.ts` → `useRoomPackages` |
| Anything else (bridge, service, codec, pure helper) | `kebab-case.ts` | `hash-utils.ts`, `game-bridge.ts`        |

One export per file owns the name. If a file's primary export and its filename
disagree, rename the file — searching for `RoomCard` must not land on
`room-card.tsx`.

Next.js reserves lowercase names for route files (`page.tsx`, `layout.tsx`,
`route.ts`). A client shell that lives beside them follows the component rule
instead, so `page.tsx` renders `RoomRouteGate` from `RoomRouteGate.tsx`, which hands the tab shell to `(godot)/RoomWorkspace.tsx`.

## Test files sit next to their subject

`<Subject>.test.tsx` / `<Subject>.test.ts` mirrors the filename exactly, so
`TagInput.tsx` is covered by `TagInput.test.tsx`.

## Placement inside a route group

- Route files (`page.tsx`, `layout.tsx`) stay at the top of their segment.
- Screen-level components and hooks a segment owns stay at that segment's root.
- Supporting modules move into a named subfolder once there are more than a
  handful of them: `(godot)/bridge/` holds the editor bridge, game bridge,
  package sync, editor storage and the package file system; `(godot)/dialogs/`
  holds the package and workshop dialogs.
- Code shared by more than one segment lives in `src/components/`,
  `src/api/`, `src/i18n/` or `src/utils/` — never in another segment's folder.

`(browser)` keeps its non-route code in `_components/` (which the App Router
ignores for routing) plus feature folders such as `login/`. `(godot)` uses the
same idea with explicit subfolders, because `_components` is not available for
a group that also owns real routes.

## Component kits and vendored registries

`src/components/` holds two generated registries next to the app-authored code.
Both keep their upstream file names, so they are the only place where a
`kebab-case.tsx` component is expected:

| Folder                   | What it is                       | Import as                            |
| ------------------------ | -------------------------------- | ------------------------------------ |
| `components/ui/`         | shadcn/ui primitives             | `@/components/ui/<name>`             |
| `components/animate-ui/` | animate-ui primitives + composed | `@/components/animate-ui/<layer>/…`  |

`components/ui/` is the default. Reach for `animate-ui/components/*` only when
the motion is part of the interaction — the public-site primary actions (login,
the room list, the editing panel). A component that both the public site and the
editor render keeps `components/ui/`, because the editor is dense and motion
there costs frames.

Do not add a third copy of a primitive that already exists in either registry.
`components.json` keeps shadcn's `ui` alias at `@/components/ui`, so a future
`shadcn add button` overwrites the existing Button instead of landing beside it.

Radix is a dependency of both registries, so import the scoped package the
component actually needs (`@radix-ui/react-dialog`, `@radix-ui/react-slot`) and
never the `radix-ui` umbrella — the umbrella ships a second copy of every
primitive.

## Why this is written down

The frontend previously mixed PascalCase, kebab-case and one snake_case file
with no rule behind any of them, so a reader could not tell a component from a
hook by its name and had to open every file to find out.
