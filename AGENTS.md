# pi-quota-panel maintenance notes

pi extension that draws a non-capturing overlay with Claude / Codex 5h·7d usage in the top-right corner.

## Layout

- `index.ts`: data fetch (`fetchAnthropic`, `fetchCodex`), burn rate (`trendOf`), rendering (`QuotaPanel`), overlay + mouse drag, `/quota` command and shortcuts.
- `diagnose.ts`: pure analysis of a time range (`analyze`): cost split, sessions, concurrency and the cause patterns with their actions. Thresholds are constants at the top; tune them against real session data, not intuition (agentic work normally reaches 4–5 turns per minute).
- `db.ts`: SQLite store `~/.pi/agent/quota-panel.db` (`quota_samples`, `turns`, `file_offsets`, `lease`, `meta`) and incremental ingest of pi session JSONL.

## Rules

- Never add `@earendil-works/*` to `dependencies` or let them be installed into `node_modules`; pi supplies them. They are optional peers.
- Validate with `npm run check` (temporarily links pi's packages for `tsc`).
- UI strings are Korean; keep the titanium palette shared with pi-team's panel (`panel #151820`, `border #2a3038`, gold title).
- The overlay options object is passed to `showOverlay` by reference and re-read every frame; dragging mutates `offsetX`/`offsetY` on it. Keep `offsetX <= 0`, `offsetY >= 0` (relative to the top-right anchor with margin top 1 / right 1) and clamp to the screen yourself so offsets never pile up off-screen.
- Use only the built-in `node:sqlite` through `process.getBuiltinModule`; keep the `emitWarning` filter in `loadSqlite`, because Node 22 prints an ExperimentalWarning to stderr that corrupts the TUI. Every store call goes through `withStore` so a locked or broken database never throws into pi. Bump `SCHEMA_VERSION` with a migration when the schema changes.
- Diagnose only when `meta.ingested_at` is recent; during the first backfill the turns table is partial and the shares (and warnings) come out wrong.
- The store API is synchronous and runs on pi's main thread: keep ingest bounded (`INGEST_BUDGET`) and never store message content.
- Do not use TypeScript parameter properties or enums; Node's type stripping (used to run `db.ts` in quick tests) rejects them.
- Every mouse interaction needs a keyboard path, because regular TUI mode leaves the mouse to the terminal (`/quota move` for dragging, `/quota login` for clicking an error row).
- Extensions cannot run built-in commands such as `/login`; `/quota login` only fills the editor with `/login <provider>` via `ctx.ui.setEditorText`. Argument completions should return `null` once the argument is complete, otherwise Enter applies the completion instead of submitting.
- Mouse events reach overlays only in fullscreen TUI mode. For end-to-end checks, run `pi --tui-mode fullscreen` in tmux and send SGR mouse sequences with `tmux send-keys -l $'\e[<0;X;YM'` (press), `$'\e[<32;X;YM'` (drag), `$'\e[<0;X;Ym'` (release).
- Without tmux, drive pi through a Python PTY plus `pyte` (`pip install pyte` in a venv) with `HOME` pointing at a scratch dir holding a fake `~/.pi/agent/auth.json`, and load the checkout with `pi --no-session -ne -e ./index.ts`.
- Bump `version` in `package.json` and add a `CHANGELOG.md` entry for each release, then tag `vX.Y.Z`.

## Deployment

Herdr machines (macbook, rogallyx, winmini, sjum-u22, EDX-DEV2, winmax2) load this package from a clone at `~/workspace/development/pi-quota-panel` listed in `~/.pi/agent/settings.json` `packages`. Update with `git pull --ff-only` on each machine, then `/reload` in running pi sessions.
