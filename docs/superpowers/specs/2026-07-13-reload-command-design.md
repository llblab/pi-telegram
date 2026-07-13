# Design: `/reload` command for pi-telegram

- **Date:** 2026-07-13
- **Status:** Approved (brainstorming gate passed). Implementation refined two points: (1) the success notify moved to BEFORE `ctx.reload()` because reload tears down the extension instance and a post-reload notify targets a stale context; (2) the reload scope is worded as "extensions, skills, prompts, and themes" to match the pi-core version pi-telegram pins (0.79.6 `ExtensionCommandContext.reload()` docstring; newer 0.80.x adds "and context files").
- **Upstream issue:** llblab/pi-telegram#124
- **Branch:** `feat/reload-command`

## Motivation

The Telegram bridge is a long-running process. Today, picking up changes to
**skills, prompt templates, context files, extensions, or config** requires
restarting the bridge process — which drops the Telegram connection and
interrupts any in-flight turn.

pi core exposes a runtime-reload primitive — `ctx.reload()` on
`ExtensionCommandContext` (demonstrated by pi-core's bundled
`examples/extensions/reload-runtime.ts`) — which reloads extensions, skills,
prompts, themes, and context files. pi-telegram does not currently expose it.

## Goal

Add a `/reload` command, invocable from Telegram, that reloads the pi runtime
live so changes take effect **without restarting the bridge**.

## Non-goals

- Live end-to-end Telegram bot testing in this environment (out of scope here;
  verified instead by the existing unit test suite + typecheck).
- Reloading only the Telegram bridge config (the existing `reloadConfig` already
  does that and stays untouched).
- Exposing reload as an LLM-callable tool (pi-core's example also ships one;
  YAGNI for now).

## Approaches considered

1. **(chosen) `/reload` command calls `ctx.reload()` directly.** Simplest,
   matches pi-core's example, and pi's turn-serial model gives us "queue after
   active turn" for free.
2. followUp self-queue: `/reload` re-enqueues an internal `/__reload` via
   `pi.sendUserMessage(..., { deliverAs: "followUp" })`. Explicitly guarantees
   post-turn execution but adds a hidden internal command + complexity.
   Rejected: unnecessary given pi serializes turns.
3. Also register an LLM-callable tool (like pi-core's example). Rejected as
   overkill for the requested feature.

## Design

### Component

New pi-side command, registered as a sibling of the existing `telegram-*`
commands in `registerTelegramBridgeCommands` (`lib/commands.ts`, ~L346+ next to
`/telegram-setup|status|connect|disconnect`).

```ts
pi.registerCommand("reload", {
  description: "Reload pi runtime: extensions, skills, prompts, themes, context files",
  handler: async (_args, ctx) => {
    try {
      await ctx.reload();
      ctx.ui.notify("Reloaded extensions, skills, prompts, themes, and context files.", "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Reload failed: ${message}`, "error");
    }
  },
});
```

### Why this works without a reserved-command entry

`/reload` is intentionally **not** added to `TELEGRAM_RESERVED_COMMAND_NAMES`.
Reserved names (stop/abort/status/compact/model/...) are intercepted by
pi-telegram's command runtime and handled "immediately"
(`TELEGRAM_COMMAND_ACTIONS`). Because `reload` is not reserved,
`buildTelegramCommandAction("reload")` returns
`{ kind: "ignore", executionMode: "ignored" }`, so pi-telegram **passes the
input through to pi**, which resolves the registered `/reload` command and runs
its handler in an `ExtensionCommandContext` that has `ctx.reload()`.

This is the same dispatch path the existing `telegram-setup|status|connect|
disconnect` commands use.

### Behavior: queue after active turn (Option B)

pi is turn-based and processes one turn at a time. A `/reload` typed while a
turn is active is accepted as the next input and executed when the current turn
ends. No special queueing logic is required — this is how `/telegram-status`
etc. already behave relative to an in-flight turn.

(To be confirmed empirically by the new unit test and, opportunistically, by a
live reload during an active turn if a bot is available.)

### Error handling

`ctx.reload()` is wrapped in try/catch. Failure produces an `error`-level
`ctx.ui.notify` with the message; success produces an `info`-level notify.
Throwing out of the handler would surface as a normal command error to pi.

## Testing

Add `tests/commands.test.ts` cases (existing file already tests the
`telegram-*` registrations):

- **Registration:** `/reload` is registered with the expected name and a
  non-empty description (mirror of the existing "register pi setup and status
  commands" test).
- **Handler success:** invoking the handler calls `ctx.reload()` exactly once
  and emits an `info` `ctx.ui.notify`.
- **Handler failure:** when `ctx.reload()` rejects, the handler emits an
  `error` `ctx.ui.notify` and does not rethrow.

`ctx` is mocked the same way the existing suite mocks
`ExtensionCommandContext` (reload + `ui.notify` spies).

Verification gate: `npm run validate` (typecheck + `node --test tests/*.test.ts`
+ audit + pack:check) must pass.

## Documentation

- `CHANGELOG.md`: add a `[Reload Command]` entry under a new version heading.
- No change to `TELEGRAM_RESERVED_COMMAND_NAMES` / bot menu required; if the
  maintainer wants `/reload` in the Telegram command menu, that is a trivial
  follow-up (out of scope for this change).

## Risks / open questions

- **`ctx.reload()` semantics in a bridge process:** reload re-initializes the
  resource loader (extensions/skills/prompts/themes/context files). The bridge's
  long-lived state (polling, bus, thread bindings) is pi-telegram-owned and is
  not expected to be reset by a pi runtime reload — but this should be sanity-
  checked (the test suite + an opportunistic live reload will confirm).
- **Naming:** `/reload` chosen over `/reload-runtime` for discoverability; the
  description makes scope explicit.

## Definition of done

- `/reload` command registered and dispatching to `ctx.reload()`.
- New unit tests pass; `npm run validate` clean.
- `CHANGELOG.md` updated.
- PR opened against `llblab/pi-telegram` from `pinion05/pi-telegram:feat/reload-command`.
