# pi-quota-panel

A [pi](https://github.com/earendil-works/pi) extension that shows a small overlay in the top-right corner with your Claude (Anthropic) and OpenAI Codex usage limits: the 5-hour and 7-day utilization and the time until each window resets.

```
╭─ 사용 한도 ──────────────── 방금 갱신 ─╮
│                                        │
│ Claude 5h  ███░░░░░░░░░  22%  ↻  3h12m │
│        7d  ████░░░░░░░░  31%  ↻ 2d 3h  │
│                                        │
╰────────────────────────────────────────╯
```

## Install

```bash
pi install git:github.com/zerodice0/pi-quota-panel
```

Or clone it and add the local path to `packages` in `~/.pi/agent/settings.json`:

```json
{ "packages": ["../../workspace/development/pi-quota-panel"] }
```

Accounts are read from pi's own login (`/login`). Providers you are not logged in to are not shown.

## Usage

| Action | How |
|---|---|
| Toggle the panel | `ctrl+shift+u`, `alt+u` or `/quota` |
| Show / hide | `/quota on`, `/quota off` |
| Refresh now | `/quota refresh` (refreshes every 3 minutes otherwise) |
| Move | Drag the panel with the mouse (fullscreen mode only) |
| Back to the default position | `/quota reset` |

The position is saved in `~/.pi/agent/quota-panel.json` and kept as an offset from the top-right corner, so the panel stays right-aligned when the terminal is resized. Mouse input reaches overlays only in pi's fullscreen TUI mode (the default); in regular mode the terminal owns the mouse.

The panel is hidden when the terminal is narrower than 82 columns.

## Data sources

- Claude: `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token.
- Codex: `GET https://chatgpt.com/backend-api/wham/usage` with the ChatGPT token.

Both are undocumented endpoints and may change.

## Development

```bash
npm run check   # type-check against the installed pi's packages
```

## License

MIT
