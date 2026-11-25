# Changelog

## 0.2.0

- Move the panel with the keyboard: `/quota move` starts a move mode (arrow keys or `hjkl`, `shift` for bigger steps, `enter` saves, `esc` cancels), and `/quota move <direction> [cells]` or `/quota move <corner>` moves it in one step. This works in regular TUI mode, where the mouse belongs to the terminal.
- `/quota login [claude|codex]` fills the editor with `/login <provider>` for an account whose token is missing or rejected; in fullscreen mode, clicking the `로그인 필요` row does the same. The panel refreshes as soon as `~/.pi/agent/auth.json` changes after the login.
- Error rows now separate login problems from rate limits, timeouts and network failures.
- Argument completion for `/quota`.

## 0.1.0

- Claude and OpenAI Codex 5h/7d usage overlay in the top-right corner, toggled with `ctrl+shift+u`, `alt+u` or `/quota`.
- Drag the panel with the mouse in fullscreen mode; the position is saved in `~/.pi/agent/quota-panel.json`. `/quota reset` restores the default position.
