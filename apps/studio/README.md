# PCB Studio

Desktop app and agent-first engine that takes a PCB from brief to fab files through explicit, gated steps,
with a live board view, Claude chat, datasheets, BOM and parts in one window. Mac first, Linux later.

Plan: `~/.claude/plans/typed-bubbling-lemur.md` (approved 2026-10-24). Hardware data stays in the iot-lab repo,
which the app opens as a project.

## Layout
- `app/` — Electron + React + TypeScript (electron-vite). Main process: engine supervisor (`src/main/engine.ts`) and the
  Claude Agent SDK host. Renderer: the UI. The engine itself is `src/main/engineMain.ts`: a separate process on the app's
  own binary, WebSocket JSON-RPC on 127.0.0.1; it prints `READY {"port": N}` and exits when its stdin closes (the app
  owns it).
- `app/resources/pcbnew_worker.py` — the only Python here: it runs on KiCad's own Python because it calls the pcbnew API.

## Develop
```sh
cd app && npm install && npm run dev            # app (starts the engine itself)
node --no-warnings --test test/*.test.ts        # engine tests
npx electron-vite build && npx playwright test  # e2e: start, crash + restart, gate, route + adopt
npm run build:web && npm run web -- --project DIR   # read-only web viewer (publish with: tailscale serve --bg 8787)
```

## Phases
0 mockups ✓ · 1 skeleton ✓ · 2 model + KiCad I/O + read-only browse · 3 runs + gates · 4 agent · 5 generic build
(NET-NODE pilot) · 6 parts, schematic, fab · 7 Linux.
