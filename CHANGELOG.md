# Changelog

All notable changes to this project will be documented in this file.

This project uses release-please to update the changelog from Conventional Commit history.

## [0.1.0](https://github.com/amux-app/amux/compare/v0.0.1...v0.1.0) (2026-08-24)


### Miscellaneous Chores

* prepare first public release ([3ebb2fc](https://github.com/amux-app/amux/commit/3ebb2fc1cc76421c3a7a5819ffebe14166e1d97d))

## 0.0.1

- Prepare Amux for its first public release.
- When the application is hidden, terminal output remains available in tmux
  copy mode. On return, Amux restores the current terminal frame but does not
  import output produced while hidden into xterm's local scrollback.
- Claude screen-reader mode is detected from live startup output. If that
  output appears while its terminal view is detached, restart the Claude pane
  to restore the intended mouse and native-scrollback behavior.
