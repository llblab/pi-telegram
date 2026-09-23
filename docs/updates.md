# Updates

`updates` owns Telegram update classification, default-routing plans, and the public update-handler registry. The internal `polling` domain owns the actual `getUpdates` loop, offsets, and abort/controller state.

`pi-telegram` owns a single `getUpdates` long-poll connection per bot. Other pi extensions cannot open a competing polling connection against the same bot — the Telegram Bot API uses a per-bot `offset` cursor, and two loops race each other and lose updates.

This document describes the registry that lets layered pi extensions running in the same pi process hook into `pi-telegram`'s polling loop and react to inbound Telegram updates **before** `pi-telegram`'s default routing fires.

The `0.28.0` transport/execution split is specified in [Durable Admission And Recovery](./architecture.md#durable-admission-and-recovery). Polling durably admits and advances batches before the independent worker invokes this registry. The worker binds source ids only after public interception passes, supplies public and built-in handlers with the same optional execution fence, settles late grouping under its exact generation, and publishes durable queue readiness. This document describes the executable public registry contract.

It is the runtime counterpart to [Callback Namespaces](./callback-namespaces.md): callback namespaces define how to share `callback_data` cleanly; update handlers define how to observe and optionally short-circuit the dispatch of those updates.

## When to use it

Use it when a layered extension needs to:

- Resolve out-of-band state, for example a `tool_call` approval Promise, the moment a Telegram callback arrives, rather than waiting for the next agent turn.
- Suppress `pi-telegram`'s default routing for callbacks owned by the layered extension, so `pi-telegram` does not also forward them as `[callback] <data>` text.
- Observe arbitrary update types such as messages, edits, channel posts, or reactions without owning the polling connection.

If the layered extension only needs to read assistant-visible callbacks, the existing `[callback] <data>` fallback documented in [Callback Namespaces](./callback-namespaces.md) is enough.

If the extension needs a durable top-level Telegram menu section with managed rendering, callback routing, authorization, and diagnostics, use the higher-level [Telegram Extension Sections](./sections.md) contract instead of a raw update handler.

## Constraints

- One bot profile has one leader-owned `getUpdates` loop. This process-local registry neither creates another transport nor replaces the Threaded Mode leader/follower bus.
- Handlers run before built-in routing in the independent semantic worker. They must return promptly because a long await delays later handler/routing execution for that source order, but it does not delay `getUpdates` admission or offset persistence. Replacement generations wait for the unsettled handler rather than executing the same update concurrently.
- Handler errors are caught and logged silently so polling never breaks. If you need durable error reporting, do it inside your handler.
- Typed handlers receive an optional second `execution` argument with `signal`, `updateId`, `generation`, `isCurrent()`, and `assertCurrent()`. Pass `signal` into cancellable work and call `assertCurrent()` immediately before irreversible effects. The runtime also rejects a verdict returned after cancellation. Legacy one-argument and zero-coupling handlers remain compatible, but any effect they commit while still awaiting is their responsibility; replacement replay still waits for that handler's actual settlement.
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

const off = registerTelegramUpdateHandler(async (update, execution) => {
  const cb = (update as { callback_query?: { id?: string; data?: string } })
    .callback_query;
  if (!cb?.data?.startsWith("myext:")) return "pass";
  await resolveMyApproval(cb, execution?.signal);
  execution?.assertCurrent();
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
type PiTelegramUpdateExecutionFence = {
  readonly generation: number;
  readonly updateId: number;
  readonly signal: AbortSignal;
  isCurrent: () => boolean;
  assertCurrent: () => void;
};
type PiTelegramUpdateHandler = (
  update: unknown,
  execution?: PiTelegramUpdateExecutionFence,
) => PiTelegramVerdict;

interface PiTelegramUpdateHandlerRegistry {
  readonly version: 1;
  add: (handler: PiTelegramUpdateHandler) => () => void;
  // Required: pi-telegram's polling loop calls this on every update.
  dispatch: (
    update: unknown,
    execution?: PiTelegramUpdateExecutionFence,
  ) => Promise<"consume" | "pass">;
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
    async dispatch(update, execution) {
      for (const handler of handlers) {
        execution?.assertCurrent();
        try {
          const result = await handler(update, execution);
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

The registry object on `globalThis.__piTelegramUpdateHandlerRegistry__` is versioned (`version: 1`) and stable across pi-telegram releases; the optional second arguments preserve existing v1 callers and implementations. Internal adapters can capture one stable check with `createTelegramUpdateExecutionFenceGuard(update)` or transfer the hidden binding across an unavoidable clone with `carryTelegramUpdateExecutionFence(source, target)`, while `getTelegramUpdateExecutionFence` and `assertTelegramUpdateExecutionCurrent` serve carriers that retain it. Future breaking changes will use a new schema version and a new key.

## Interaction with built-in routing

`pi-telegram` invokes registered handlers first, then routes the update through its own handlers: commands, app menu, queue menu, model menu, default prompt routing, and callback namespace fallback. If any handler returns `"consume"`, `pi-telegram` skips the rest of routing for that update.

Default routing ignores `deleted_business_messages`. Telegram's [BusinessMessagesDeleted](https://core.telegram.org/bots/api#businessmessagesdeleted) belongs to a connected business account; [Message.business_connection_id](https://core.telegram.org/bots/api#message) explicitly distinguishes that account's chats from bot chats with the same IDs. Such an update cannot delete private Pi queue entries or pending media groups. Raw handlers still receive the carrier and may own their own namespace-aware behavior. The polling filter is not an authority check: Telegram may return updates created before a changed `allowed_updates` setting.

This means:

- Extensions can claim callback namespaces that `pi-telegram` would otherwise forward as `[callback] <data>` text.
- Extensions can observe updates by always returning `"pass"`.
- Extensions must not consume updates that belong to `pi-telegram`'s own prefixes (`compact:`, `new:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, `section:`) unless they are deliberately replacing that behavior.

## Ownership semantics

The handler registry is ownership-agnostic and does not interact with the extension-local transport owner slots documented in [Architecture](./architecture.md#configuration-and-ownership). When the polling runtime loses its `owners.json` slot and stops `getUpdates`, handlers stop receiving updates because no updates are being fetched; they are not unregistered.

If a layered extension needs to react to ownership changes, it should observe `pi-telegram` lifecycle events through the standard pi extension hooks rather than through the handler registry.

## Not a transport multiplexer

This registry does not bypass Telegram's single-polling-connection-per-bot constraint and does not route updates between processes. Threaded Mode provides the separate profile-scoped leader/follower bus: the leader owns `getUpdates`, applies its process-local update registry, and then routes retained built-in traffic to the owning instance. The registry remains an in-process extension interception surface only.

## Relationship to extension sections

Update handlers are the raw update primitive. Extension sections are the structured Telegram UI layer above that primitive.

Use update handlers for immediate update interception, custom callback namespaces, out-of-band Promise resolution, and update types that should not become a Telegram menu surface.

Use extension sections when the desired behavior is a menu-integrated UI: `render(ctx)`, managed callback dispatch, safe runtime ports, stale-callback handling, and diagnostics owned by `pi-telegram`.
