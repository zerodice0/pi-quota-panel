# pi-quota-panel

A [pi](https://github.com/earendil-works/pi) extension that shows a small overlay in the top-right corner with your Claude (Anthropic) and OpenAI Codex usage limits: the 5-hour and 7-day utilization and the time until each window resets.

```
╭─ 사용 한도 ──────────────── 방금 갱신 ─╮
│                                        │
│ Claude 5h  █████░░░░░░░  38%  ↻ 3h59m  │
│        +18%/h · 19:34 소진 예상        │
│        7d  █████░░░░░░░  45%  ↻ 1d23h  │
│        +15%/일 · 리셋까지 여유         │
│        원인: 큰 컨텍스트 반복          │
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
| Move with the keyboard | `/quota move`, then arrow keys or `hjkl` (`shift` for bigger steps), `r` for the default position, `enter` to save, `esc` to cancel |
| Move in one step | `/quota move left\|right\|up\|down [cells]`, `/quota move top-left\|top-right\|bottom-left\|bottom-right` |
| Move with the mouse | Drag the panel (fullscreen mode only) |
| Back to the default position | `/quota reset` |
| Log in again | `/quota login [claude\|codex]`, or click a `로그인 필요` row (fullscreen mode) |
| Why usage jumped | `/quota why [claude\|codex] [30m\|1h\|3h\|5h\|24h]`, or click a `원인:` row (fullscreen mode) |

The position is saved in `~/.pi/agent/quota-panel.json` and kept as an offset from the top-right corner, so the panel stays right-aligned when the terminal is resized. Mouse input reaches overlays only in pi's fullscreen TUI mode (the default); in regular mode the terminal owns the mouse, so use `/quota move` there.

When a token is missing or rejected (HTTP 401/403), the row shows `로그인 필요 · /quota login`. Extensions cannot run pi's built-in `/login` themselves, so `/quota login` fills the editor with `/login <provider>`; press Enter to start the login. The panel watches `~/.pi/agent/auth.json` and refreshes as soon as the login finishes. Other failures (rate limits, network errors) show the reason and are retried on the next refresh.

The panel is hidden when the terminal is narrower than 82 columns.

## Burn rate and history

Under each window the panel shows how fast it is being used: the last hour for the 5-hour window (`%/h`) and the last 24 hours for the 7-day window (`%/일`). If the window would run out before it resets at that pace, the line turns red and shows the projected time (`19:34 소진 예상`); otherwise it reads `리셋까지 여유`. The line appears once there are enough samples (10 minutes for 5h, 2 hours for 7d).

History lives in a small SQLite database, `~/.pi/agent/quota-panel.db`, through Node's built-in `node:sqlite` (no extra dependency):

- `quota_samples`: every 5h/7d utilization the panel fetched.
- `turns`: per-turn token counts and cost collected incrementally from pi's session logs (`~/.pi/agent/sessions`, subagent runs included). Message content is never stored.
- `lease`: several pi sessions on one machine share the database, and only one of them calls the usage API or reads the session logs at a time. The others reuse the shared result, so opening many panes does not multiply API calls.

Records older than 60 days are removed. If `node:sqlite` is unavailable the panel still works, without the burn rate. The database only covers this machine; usage from other machines or from Claude Code / Codex CLI counts against the same limits but is not in the logs.

## Finding the cause of a spike

When the 5-hour usage rises by 5 points or more within 15 minutes, or either window would run out before it resets, the panel analyzes the last hour of this machine's pi sessions and adds a `원인:` line with the main pattern. If the current session accounts for at least 20% of that hour's cost, it also shows a warning with the action to take (at most once every 30 minutes per account).

`/quota why` opens the full analysis: the usage rise, the main cause and the action, other causes, the top sessions (the current one is marked), the cost split, context size, models and tools. `tab` switches accounts, `←`/`→` change the range, `esc` closes it.

| Pattern | Signal | Action |
|---|---|---|
| 큰 컨텍스트 반복 | Average context of 120k tokens or more | `/compact`, or write a handoff and start a new session |
| 짧은 턴 폭주 | One session with 30+ turns in 10 minutes, median output of 250 tokens or less, one tool for 85%+ of calls | Stop the polling or retry loop; wait in one script instead |
| 동시 실행 | Three or more sessions active in the same 10 minutes | Run fewer sessions and subagents at once |
| 캐시 미스 | Cache writes are 25%+ of the cost | Batch model and setting changes; compact long-idle sessions before resuming |
| 출력 과다 | Output is 40%+ of the cost | Lower the thinking level and shorten outputs |
| 외부 사용 | Usage rose 3+ points but this machine logged fewer than 3 turns | Check other machines and Claude Code / Codex CLI |
| 비싼 모델 | An Opus model is 80%+ of the cost (shown with another cause) | Use Sonnet or Haiku for routine work |

Cost comes from pi's session logs and only approximates how providers count usage against the limits. For models without prices, tokens weighted by relative price (output ×5, cache read ×0.1, cache write ×1.25) are used instead.

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
