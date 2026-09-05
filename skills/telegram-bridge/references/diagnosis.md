# Bridge Diagnosis

Read this reference only when diagnosing Telegram bridge health or delivery failure.

Inspect in this order:

1. `/telegram-status` for compact health in the Pi TUI.
2. `/telegram-status --debug` for bounded human-readable diagnostics in the Pi TUI.
3. `~/.pi/agent/tmp/telegram/state.json` and `logs.jsonl` for default-profile redacted evidence.
4. `state.<profile>.json` and `logs.<profile>.jsonl` for a named profile.

These slash commands are registered Pi commands, not shell executables or agent tools. If the agent cannot invoke them through a supported Pi surface, read the diagnostic files directly; do not run them in Bash or inject terminal input.

When `PI_CODING_AGENT_DIR` selects another compatible runtime, resolve its equivalent `tmp/telegram` directory.

Do not mutate ownership files, bridge state, journals, bindings, or locks to force recovery. Use supported commands and preserve exact profile, target, transport, and session authority. Never claim successful delivery without transport evidence.
