# Updates

`updates` owns Telegram update classification, default-routing plans, and the public update-handler registry. The internal `polling` domain owns the actual `getUpdates` loop, offsets, and abort/controller state.

`pi-telegram` owns a single `getUpdates` long-poll connection per bot. Other pi extensions cannot open a competing polling connection against the same bot — the Telegram Bot API uses a per-bot `offset` cursor, and two loops race each other and lose updates.

This document describes the registry that lets layered pi extensions running in the same pi process hook into `pi-telegram`'s polling loop and react to inbound Telegram updates **before** `pi-telegram`'s default routing fires.

It is the runtime counterpart to [Callback Namespaces](./callback-namespaces.md): callback namespaces define how to share `callback_data` cleanly; update handlers define how to observe and optionally short-circuit the dispatch of those updates.

## When to use it

Use it when a layered extension needs to:

- Resolve out-of-band state, for example a `tool_call` approval Promise, the moment a Telegram callback arrives, rather than waiting for the next agent turn.
- Suppress `pi-telegram`'s default routing for callbacks owned by the layered extension, so `pi-telegram` does not also forward them as `[callback] <data>` text.
- Observe arbitrary update types such as messages, edits, channel posts, or reactions without owning the polling connection.

If the layered extension only needs to read assistant-visible callbacks, the existing `[callback] <data>` fallback documented in [Callback Namespaces](./callback-namespaces.md) is enough.

If the extension needs a durable top-level Telegram menu section with managed rendering, callback routing, authorization, and diagnostics, use the higher-level [Telegram Extension Sections](./sections.md) contract instead of a raw update handler.

## Constraints

- One bot, one pi process, one `getUpdates` loop. This registry does **not** enable running multiple pi instances against the same bot.
- Handlers run in the polling loop. They must return quickly; long awaits delay subsequent updates.
- Handler errors are caught and logged silently so polling never breaks. If you need durable error reporting, do it inside your handler.
- The registry lives on `globalThis`. Module instance identity is not required, so layered extensions can reach it without importing `@llblab/pi-telegram`.

## Verdicts

Each handler returns one of:

- `"consume"` — `pi-telegram` skips its default routing for this update.
- `"pass"` or `void` / `undefined` — `pi-telegram` routes the update normally. Other handlers registered after this one still run for the same update.

The first handler that returns `"consume"` wins; later handlers are not called for that update.

## Registering a handler

Two equivalent paths.

### Typed import (recommended when you can depend on `@llblab/pi-telegram`)

```ts
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";

const off = registerTelegramUpdateHandler(async (update) => {
  const cb = (update as { callback_query?: { id?: string; data?: string } })
    .callback_query;
  if (!cb?.data?.startsWith("myext:")) return "pass";
  await resolveMyApproval(cb);
  return "consume";
});

// Later, when your extension shuts down:
off();
```

### Zero-coupling globalThis lookup

When the layered extension prefers no `import` from `@llblab/pi-telegram`, so load order between the two extensions does not matter and either can be installed first, it must implement the **full v1 registry contract**, not just `version` and `add`. pi-telegram's polling runtime calls `dispatch` on whatever object it finds at `globalThis.__piTelegramUpdateHandlerRegistry__`, so a partial object would silently break the first update.

pi-telegram defensively re-creates the registry if the object on `globalThis` is missing `add` or `dispatch`, validated as `version === 1`, `typeof add === "function"`, and `typeof dispatch === "function"`. Handlers registered against a malformed object are dropped — make sure your bootstrap implements all three fields.

```ts
type PiTelegramVerdict =
  | "consume"
  | "pass"
  | void
  | Promise<"consume" | "pass" | void>;
type PiTelegramUpdateHandler = (update: unknown) => PiTelegramVerdict;

interface PiTelegramUpdateHandlerRegistry {
  readonly version: 1;
  add: (handler: PiTelegramUpdateHandler) => () => void;
  // Required: pi-telegram's polling loop calls this on every update.
  dispatch: (update: unknown) => Promise<"consume" | "pass">;
}

const REGISTRY_KEY = "__piTelegramUpdateHandlerRegistry__";

function getOrCreateRegistry(): PiTelegramUpdateHandlerRegistry {
  const g = globalThis as Record<string, unknown>;
  const existing = g[REGISTRY_KEY] as
    | PiTelegramUpdateHandlerRegistry
    | undefined;
  if (
    existing &&
    existing.version === 1 &&
    typeof existing.add === "function" &&
    typeof existing.dispatch === "function"
  ) {
    return existing;
  }
  const handlers = new Set<PiTelegramUpdateHandler>();
  const registry: PiTelegramUpdateHandlerRegistry = {
    version: 1,
    add(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispatch(update) {
      for (const handler of handlers) {
        try {
          const result = await handler(update);
          if (result === "consume") return "consume";
        } catch {
          // Never break polling because of a handler error.
        }
      }
      return "pass";
    },
  };
  g[REGISTRY_KEY] = registry;
  return registry;
}

const off = getOrCreateRegistry().add((update) => {
  /* … */
  return "pass";
});
```

The registry object on `globalThis.__piTelegramUpdateHandlerRegistry__` is versioned (`version: 1`) and stable across pi-telegram releases; future breaking changes will use a new schema version and a new key.

## Interaction with built-in routing

`pi-telegram` invokes registered handlers first, then routes the update through its own handlers: commands, app menu, queue menu, model menu, default prompt routing, and callback namespace fallback. If any handler returns `"consume"`, `pi-telegram` skips the rest of routing for that update.

This means:

- Extensions can claim callback namespaces that `pi-telegram` would otherwise forward as `[callback] <data>` text.
- Extensions can observe updates by always returning `"pass"`.
- Extensions must not consume updates that belong to `pi-telegram`'s own prefixes (`compact:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, `section:`) unless they are deliberately replacing that behavior.

## Ownership semantics

The handler registry is ownership-agnostic and does not interact with the extension-local transport owner slots documented in [Architecture](./architecture.md#configuration-and-ownership). When the polling runtime loses its `owners.json` slot and stops `getUpdates`, handlers stop receiving updates because no updates are being fetched; they are not unregistered.

If a layered extension needs to react to ownership changes, it should observe `pi-telegram` lifecycle events through the standard pi extension hooks rather than through the handler registry.

## Not a multiplexer

This registry does not multiplex one bot across multiple pi processes, and it does not bypass Telegram's single-polling-connection-per-bot constraint. To run multiple pi instances on Telegram, give each instance its own bot and its own `~/.pi/agent` directory; the registry is for layered extensions inside **one** pi process.

## Relationship to extension sections

Update handlers are the raw update primitive. Extension sections are the structured Telegram UI layer above that primitive.

Use update handlers for immediate update interception, custom callback namespaces, out-of-band Promise resolution, and update types that should not become a Telegram menu surface.

Use extension sections when the desired behavior is a menu-integrated UI: `render(ctx)`, managed callback dispatch, safe runtime ports, stale-callback handling, and diagnostics owned by `pi-telegram`.
