# Project Backlog

- [ ] Track a public Pi session-replacement hook before adding Telegram `/new`.
  - Context: `pi-telegram` is an extension/mobile companion, not a PTY supervisor. A soft `/new` that mutates session internals or filters context without TUI/runtime parity breaks the product boundary.
  - Requirement: only add Telegram `/new` when Pi exposes a safe public API that invokes the same session-replacement path as terminal `/new`, including lifecycle, active-run handling, and TUI rerender semantics.
  - Rejected for this extension: raw TTY injection, ANSI terminal clearing, private TUI container mutation, or running a shadow `pi` subprocess to control the current session.

- [ ] Consider splitting `lib/bindings.ts` if lifecycle/tool wiring grows further.
