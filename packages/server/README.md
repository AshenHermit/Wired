# Wired server

NestJS API and asset server for Wired: rooms, users, scripting packages, the
Godot editor assets, the room runtime and the game export.

`AGENTS.md` at the repository root is the only maintained map of the repo. It
covers the module layout, the environment knobs (all of them are read in
`src/config/config.ts`), how to fetch the pinned Godot editor/runtime/templates,
and how the Docker deploy works.
