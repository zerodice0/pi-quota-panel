# Changelog

## 0.7.2

- The exhaustion time after today is shown in days and hours, rounded down (`4일 3시간 뒤 소진`). 0.7.1 rounded up to whole days, so a window running out in 4.1 days read `5일 내` next to a reset in 4d14h and the red warning looked wrong.

## 0.7.1

- The projected exhaustion time is shorter and relative after today: `5일 내 소진` or `9시간 내 소진` instead of the day of the month and hour (`1일 8시 소진`), which was cut off on narrow screens and easy to misread.

## 0.7.0

- `/quota mark [claude|codex] [30m|1h|2h|3h] [memo]` records the moment of a fix and measures its effect: the period after it is compared with the latest spike (or the hour before), led by the cost per hour of the session that caused it. The verdict (개선, 변화 작음, 악화, 급증 재발, 판단 불가) is notified once when the window ends and stays in the panel and the usage line for three hours.
- `/quota check [claude|codex]` shows the before/after comparison at any time; in fullscreen mode, clicking the `조치 효과` row opens it.
- `quota_effect` tool (`mark` / `check`) so agents can start a measurement and read the result without waiting or polling.
- The cause line only shows while usage is actually spiking. Afterwards it becomes a dim `급증 멈춤 HH:MM · <cause>` for three hours, and a window that would run out before reset only colors the usage red instead of attaching a cause.
- Accounts without a 5-hour window are checked for spikes on the 7-day window (2+ points within an hour).
- Burn rates react faster: the last 30 minutes for 5h (was 1 hour) and the last 6 hours for 7d (was 24 hours).

## 0.6.0

- The usage summary moved from the footer status to a line right under the editor. Below 100 columns it shows only the usage per account, colored red when a window would run out before it resets or usage is spiking, instead of the long warning (which also squeezed the footer on phones).
- Clicking the usage line opens or closes the panel (fullscreen mode).
- The panel now shows on narrow terminals as long as it fits (44 columns), so it can be opened from a phone.

## 0.5.1

- The panel shortcut is now `ctrl+shift+r` (`alt+u` still works). On Linux, `ctrl+shift+u` is taken by fcitx5/IBus and, when the input method passes it on, by GTK's built-in hex Unicode entry, which hides its input so the terminal looks frozen until Space or Enter commits a stray character.

## 0.5.0

- Collection no longer depends on the panel: every interactive (TUI) pi session starts the collector at session start, so history, diagnosis and spike warnings keep working while the panel is hidden. The panel still starts hidden, and `/quota off` only hides it.
- Status line summary (`Claude 5h 42% +22%/h 19:01 소진 큰 컨텍스트 반복 · Codex 7d 77%`) in every TUI session, including custom footers that show extension statuses.
- Session-log ingest is skipped when another pi process finished one less than 50 seconds ago, so the logs are scanned once a minute per machine. The usage fetch stays at one call every 3 minutes per machine.
- RPC, JSON and print runs (such as subagent children) never start the collector.
- After `/new`, `/resume` or `/fork` the panel comes back if it was shown.

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
