# PCB Studio

Desktop app and agent-first engine that takes a PCB from brief to fab files through explicit, gated steps,
with a live board view, Claude chat, datasheets, BOM and parts in one window. Mac first, Linux later.

Plan: `~/.claude/plans/typed-bubbling-lemur.md` (approved 2026-10-24). Hardware data stays in the iot-lab repo,
which the app opens as a project.

## Layout
- `app/` — Electron + React + TypeScript (electron-vite). Main process: engine supervisor (`src/main/engine.ts`),
  later the Claude Agent SDK host. Renderer: the UI.
- `engine/` — Python 3.12 package `pcbstudio` (uv). `pcbstudio serve` = WebSocket JSON-RPC on 127.0.0.1; prints
  `READY {"port": N}` and exits when its stdin closes (the app owns it).

## Develop
```sh
cd engine && uv sync && uv run pytest -q        # engine tests
cd app && npm install && npm run dev            # app (starts the engine itself)
cd app && npx electron-vite build && npx playwright test   # e2e: start, ping, crash + restart
```
`PCBSTUDIO_ENGINE_DIR` overrides the engine folder; `PCBSTUDIO_UV` the uv binary.

## Phases
0 mockups ✓ · 1 skeleton ✓ · 2 model + KiCad I/O + read-only browse · 3 runs + gates · 4 agent · 5 generic build
(NET-NODE pilot) · 6 parts, schematic, fab · 7 Linux.
