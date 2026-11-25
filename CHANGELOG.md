# Changelog

## 0.4.0

- Cause of usage spikes: when the 5-hour usage rises 5+ points in 15 minutes or a window would run out before reset, the panel shows the main pattern of the last hour (`원인: …`), and the session responsible for 20%+ of the cost gets a warning with the action to take.
- `/quota why [claude|codex] [30m|1h|3h|5h|24h]` shows the analysis: usage rise, main and other causes with actions, top sessions, cost split, context size, models and tools. In fullscreen mode, clicking the `원인:` row opens it.
- Patterns: large repeated context, short-turn loops, parallel sessions, cache misses, heavy output, usage from elsewhere and premium models.
- The `turns` table now keeps cost per input, output, cache read and cache write.

## 0.3.0

- Burn rate under each window (`%/h` for 5h, `%/일` for 7d) with the projected exhaustion time when the window would run out before it resets.
- Usage history in `~/.pi/agent/quota-panel.db` (built-in `node:sqlite`): utilization samples and per-turn token counts collected incrementally from pi's session logs, kept for 60 days.
- pi sessions on the same machine share one usage fetch through a database lease instead of each calling the usage API every 3 minutes.

## 0.2.0

- Move the panel with the keyboard: `/quota move` starts a move mode (arrow keys or `hjkl`, `shift` for bigger steps, `enter` saves, `esc` cancels), and `/quota move <direction> [cells]` or `/quota move <corner>` moves it in one step. This works in regular TUI mode, where the mouse belongs to the terminal.
- `/quota login [claude|codex]` fills the editor with `/login <provider>` for an account whose token is missing or rejected; in fullscreen mode, clicking the `로그인 필요` row does the same. The panel refreshes as soon as `~/.pi/agent/auth.json` changes after the login.
- Error rows now separate login problems from rate limits, timeouts and network failures.
- Argument completion for `/quota`.

## 0.1.0

- Claude and OpenAI Codex 5h/7d usage overlay in the top-right corner, toggled with `ctrl+shift+u`, `alt+u` or `/quota`.
- Drag the panel with the mouse in fullscreen mode; the position is saved in `~/.pi/agent/quota-panel.json`. `/quota reset` restores the default position.
