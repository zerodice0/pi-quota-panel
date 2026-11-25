# pi-quota-panel maintenance notes

pi extension that draws a non-capturing overlay with Claude / Codex 5h·7d usage in the top-right corner.

## Layout

- `index.ts`: everything. Data fetch (`fetchAnthropic`, `fetchCodex`), rendering (`QuotaPanel`), overlay + mouse drag, `/quota` command and shortcuts.

## Rules

- Never add `@earendil-works/*` to `dependencies` or let them be installed into `node_modules`; pi supplies them. They are optional peers.
- Validate with `npm run check` (temporarily links pi's packages for `tsc`).
- UI strings are Korean; keep the titanium palette shared with pi-team's panel (`panel #151820`, `border #2a3038`, gold title).
- The overlay options object is passed to `showOverlay` by reference and re-read every frame; dragging mutates `offsetX`/`offsetY` on it. Keep `offsetX <= 0`, `offsetY >= 0` (relative to the top-right anchor with margin top 1 / right 1) and clamp to the screen yourself so offsets never pile up off-screen.
- Every mouse interaction needs a keyboard path, because regular TUI mode leaves the mouse to the terminal (`/quota move` for dragging, `/quota login` for clicking an error row).
- Extensions cannot run built-in commands such as `/login`; `/quota login` only fills the editor with `/login <provider>` via `ctx.ui.setEditorText`. Argument completions should return `null` once the argument is complete, otherwise Enter applies the completion instead of submitting.
- Mouse events reach overlays only in fullscreen TUI mode. For end-to-end checks, run `pi --tui-mode fullscreen` in tmux and send SGR mouse sequences with `tmux send-keys -l $'\e[<0;X;YM'` (press), `$'\e[<32;X;YM'` (drag), `$'\e[<0;X;Ym'` (release).
- Without tmux, drive pi through a Python PTY plus `pyte` (`pip install pyte` in a venv) with `HOME` pointing at a scratch dir holding a fake `~/.pi/agent/auth.json`, and load the checkout with `pi --no-session -ne -e ./index.ts`.
- Bump `version` in `package.json` and add a `CHANGELOG.md` entry for each release, then tag `vX.Y.Z`.

## Deployment

Herdr machines (macbook, rogallyx, winmini, sjum-u22, EDX-DEV2, winmax2) load this package from a clone at `~/workspace/development/pi-quota-panel` listed in `~/.pi/agent/settings.json` `packages`. Update with `git pull --ff-only` on each machine, then `/reload` in running pi sessions.
