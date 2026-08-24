# Changelog

All notable changes to this project will be documented in this file.

This project uses release-please to update the changelog from Conventional Commit history.

## 0.0.1

- Prepare Amux for its first public release.
- When the application is hidden, terminal output remains available in tmux
  copy mode. On return, Amux restores the current terminal frame but does not
  import output produced while hidden into xterm's local scrollback.
- Claude screen-reader mode is detected from live startup output. If that
  output appears while its terminal view is detached, restart the Claude pane
  to restore the intended mouse and native-scrollback behavior.
