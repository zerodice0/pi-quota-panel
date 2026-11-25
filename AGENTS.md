# pi-quota-panel maintenance notes

pi extension that draws a non-capturing overlay with Claude / Codex 5h·7d usage in the top-right corner.

## Layout

- `index.ts`: everything. Data fetch (`fetchAnthropic`, `fetchCodex`), rendering (`QuotaPanel`), overlay + mouse drag, `/quota` command and shortcuts.

## Rules

- Never add `@earendil-works/*` to `dependencies` or let them be installed into `node_modules`; pi supplies them. They are optional peers.
- Validate with `npm run check` (temporarily links pi's packages for `tsc`).
- UI strings are Korean; keep the titanium palette shared with pi-team's panel (`panel #151820`, `border #2a3038`, gold title).
- The overlay options object is passed to `showOverlay` by reference and re-read every frame; dragging mutates `offsetX`/`offsetY` on it. Keep `offsetX <= 0`, `offsetY >= 0` (relative to the top-right anchor with margin top 1 / right 1) and clamp to the screen yourself so offsets never pile up off-screen.
- Mouse events reach overlays only in fullscreen TUI mode. For end-to-end checks, run `pi --tui-mode fullscreen` in tmux and send SGR mouse sequences with `tmux send-keys -l $'\e[<0;X;YM'` (press), `$'\e[<32;X;YM'` (drag), `$'\e[<0;X;Ym'` (release).
- Bump `version` in `package.json` and add a `CHANGELOG.md` entry for each release, then tag `vX.Y.Z`.

## Deployment

Herdr machines (macbook, rogallyx, winmini, sjum-u22, EDX-DEV2, winmax2) load this package from a clone at `~/workspace/development/pi-quota-panel` listed in `~/.pi/agent/settings.json` `packages`. Update with `git pull --ff-only` on each machine, then `/reload` in running pi sessions.
