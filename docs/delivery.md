# Telegram Delivery API

## Purpose

The Telegram Delivery API gives trusted extension consumers a safe programmatic way to render operational Telegram UI without importing bridge internals or owning Telegram transport.

It fills the boundary between callback-scoped `TelegramSectionContext.open()` and agent-callable `telegram_message` / `telegram_attach`. It does not replace normal active-turn final replies, Sections, outbound handlers, or raw update handlers.

The public package membrane is:

```ts
import {
  deleteTelegramView,
  editTelegramView,
  sendTelegramChatAction,
  sendTelegramView,
} from "@llblab/pi-telegram/delivery";
```

## Ownership Boundary

Consumer extension code owns:

- When an operational view should appear.
- View text, parse mode, and optional inline keyboard.
- Its own settings and callback policy.
- Retaining a returned handle only for the current live extension generation.

pi-telegram owns:

- Active-turn and current-instance target resolution.
- Pairing and target authorization.
- Classic direct transport versus follower-to-leader routing.
- Named-profile isolation.
- Per-target operation ordering.
- Telegram text limits, rendering, and chunk reconciliation.
- Runtime generation checks, shutdown behavior, and diagnostics.
- Bot credentials, polling, offsets, retries, and raw API clients.

## Public Contract

### Views

```ts
export type TelegramDeliveryParseMode = "plain" | "html" | "markdown";

export interface TelegramDeliveryView {
  text: string;
  parseMode?: TelegramDeliveryParseMode;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}
```

`plain` is the default. Operational activity should prefer `plain` or explicit `html`. `markdown` exists for extension-authored content that naturally owns Markdown; the bridge converts it through the existing UI/compat Markdown-to-HTML renderer rather than entering the native assistant final-reply pipeline.

`replyMarkup` accepts only structural keyboard data. Callback ownership stays with Sections or a registered raw update handler. The documented issue #126 consumer shape uses Sections for interactive Settings toggles and keeps delivered activity rows non-interactive, so a second managed callback registry would duplicate token, answer, edit, navigation, and cleanup ownership without a proven use case. Revisit only when a public-import-only consumer must generate managed callbacks independently of a registered Section context for arbitrary delivered messages.

### Target scopes

```ts
export type TelegramDeliveryScope =
  | { kind: "active-turn" }
  | { kind: "instance" }
  | { kind: "aggregate" }
  | { kind: "target"; target: TelegramDeliveryTarget };

export interface TelegramDeliveryTarget {
  chatId: number;
  threadId?: number;
}
```

Resolution rules:

- `active-turn` requires a current Telegram-owned turn and resolves its exact `{ chatId, threadId? }`.
- `instance` resolves the current process's assigned follower/leader thread, or the paired private chat in classic mode. It does not silently fall back to an unrelated active thread.
- `aggregate` resolves the paired private chat without `threadId`; it is the Threaded Mode `All` surface and the ordinary classic chat. Follower aggregate messages carry an internal authenticated-bus marker that the leader validates for the assigned chat and strips before Bot API transport; unmarked or cross-chat threadless follower writes remain denied.
- `target` validates an explicit destination against the active profile and current runtime authority. A classic owner may target its paired private chat. A follower may target only its assigned thread or aggregate surface. A leader may target its own thread, aggregate surface, or a currently live bound thread for that profile. Unknown, stale, cross-profile, and unpaired targets are rejected.

No scope selects another named profile. Profile activation remains session-local bridge state.

### Handles

```ts
export interface TelegramDeliveryHandle {
  readonly target: TelegramDeliveryTarget;
  readonly messageIds: readonly number[];
  readonly generation: string;
}
```

A handle represents one logical view, which may span multiple Telegram messages after chunking. `generation` is an opaque runtime identity, not an authorization secret. Callers must not construct handles or persist them across reload/session replacement.

Edit reconciles the logical view as one operation:

- Existing chunks are edited in order.
- Additional chunks are sent when the new view grows.
- Surplus old chunks are deleted when the new view shrinks.
- The returned handle replaces the previous handle.

Delete removes every message still represented by the handle. Partial transport failure returns a structured failure and records diagnostics; it never pretends the whole logical view succeeded.

### Results

```ts
export type TelegramDeliveryFailureReason =
  | "runtime-unavailable"
  | "target-unavailable"
  | "target-unauthorized"
  | "stale-handle"
  | "invalid-view"
  | "commit-unknown"
  | "transport-failed";

export type TelegramDeliveryResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: TelegramDeliveryFailureReason;
      message: string;
      partial?: T;
    };
```

Expected availability, authorization, lifecycle, and ambiguous mutation outcomes return failures rather than throwing. `commit-unknown` means a non-idempotent Bot API mutation may have committed before its response was lost; callers must not blindly replay it. When earlier chunks remain known, `partial` still carries their recoverable logical handle. Programmer errors may still throw for malformed objects that cannot satisfy the TypeScript contract. Transport failures are redacted before reaching callers and are also recorded in bridge runtime diagnostics.

When a multi-chunk `send` or growing `edit` fails after materializing part of the logical view, `partial` contains a valid handle for every message still visible from that operation. Callers may pass it to `editTelegramView` to reconcile the view or to `deleteTelegramView` for cleanup. A failure before any message exists omits `partial`; callers must never infer message ids or construct a handle.

### Operations

```ts
export interface SendTelegramViewOptions {
  scope: TelegramDeliveryScope;
  replyToMessageId?: number;
}

export function sendTelegramView(
  view: TelegramDeliveryView,
  options: SendTelegramViewOptions,
): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;

export function editTelegramView(
  handle: TelegramDeliveryHandle,
  view: TelegramDeliveryView,
): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;

export function deleteTelegramView(
  handle: TelegramDeliveryHandle,
): Promise<TelegramDeliveryResult<void>>;

export function sendTelegramChatAction(
  action: "typing" | "upload_document" | "upload_photo" | "record_voice",
  options: { scope: TelegramDeliveryScope },
): Promise<TelegramDeliveryResult<void>>;
```

`replyToMessageId` applies only to the first chunk and must belong to the resolved chat. The initial contract exposes only actions already used by bridge-owned activity and delivery paths; it is not a generic Bot API action string.

## Runtime Binding

The public functions resolve a process-local runtime binding on every call. They never capture a Pi `ExtensionContext` or command context.

The bridge constructs and binds a genuinely fresh delivery runtime during every `session_start`. It unbinds and shuts down the current runtime during `session_shutdown` before session-bound transport state is discarded; binding an unexpected replacement also shuts down the displaced runtime. Reload and session replacement therefore produce these outcomes:

- A new call resolves the newly bound runtime after startup.
- An old handle returns `stale-handle` for edit and delete.
- A call while no generation is bound returns `runtime-unavailable`.
- Queued operations from the old generation stop before transport begins.
- An already-issued Telegram request may resolve during shutdown, but the old operation returns `runtime-unavailable` and cannot issue another edit, delete, chunk, or chat action afterward.
- Old operations never adopt the replacement generation implicitly.

The binding uses the same `globalThis` membrane pattern as other extension registries so package load order does not expose bridge internals. Only pi-telegram may bind or replace the runtime port.

## Ordering And Delivery Semantics

- Operations serialize per profile and concrete target. Different targets may progress independently.
- `send`, logical `edit`, and logical `delete` preserve caller order for the same target.
- Delivery uses the existing bridge API runtime so followers route allowlisted calls through the leader rather than contacting Telegram directly.
- Text is chunked through the existing parse-mode-appropriate renderer/splitter. HTML chunks remain balanced, extension-authored Markdown becomes balanced UI/compat HTML, and plain chunks preserve text.
- Inline keyboard markup attaches only to the final chunk of a logical view. Reply parameters attach only to the first chunk.
- Edit growth sends additional chunks; edit shrink deletes surplus chunks; delete removes every chunk in handle order.
- A partial send failure returns the ids already sent. A partial edit failure returns the original surviving ids plus every newly sent id, minus any surplus ids already deleted during shrink. The returned handle therefore remains sufficient for deterministic retry or cleanup.
- The API does not participate in assistant preview/final deduplication and does not mutate the Telegram turn queue.
- A successful operational send does not imply agent work, create a Pi prompt, or alter terminal status.

## Diagnostics

Failures record redacted runtime events under a delivery-specific category with operation, scope kind, profile, and failure reason. Diagnostics must not include bot tokens, unrestricted message bodies, callback payload secrets, or raw transport responses.

A future `getTelegramDeliveryDiagnostics()` is unnecessary for the first slice because callers receive structured results and `/telegram-status` already owns bridge diagnostics. Add a dedicated diagnostics getter only if a real consumer needs registry-level introspection.

## Security And Non-Goals

The API does not expose:

- Bot tokens or raw Telegram clients.
- Arbitrary Bot API methods.
- A second polling loop.
- Cross-profile delivery.
- Unrestricted cross-instance targeting.
- Session replacement, reload, process launch, or Pi slash-command dispatch.
- File/media uploads in the first 0.21 slice.
- Captured Pi contexts or mutable queue/session state.

Extension consumers remain trusted local code, but the contract still preserves product ownership boundaries so accidental misuse cannot silently bypass Threaded Mode routing or target identity.

## Validation Contract

The implementation must cover:

- Classic `instance` and `aggregate` resolution.
- Leader own-thread, aggregate, and live-bound explicit target resolution.
- Follower assigned-thread and aggregate routing through the leader.
- Missing active turns and disconnected runtimes.
- Cross-profile, unknown, stale, and unauthorized explicit targets.
- Plain, HTML, and Markdown chunking.
- Reply-first and keyboard-last chunk placement.
- Send/edit growth/edit shrink/delete ordering.
- Reload/session-replacement generation invalidation.
- In-flight shutdown fencing and redacted diagnostics.
- Package-boundary imports with no `/lib` access.

## Relationship To Activity

The Activity API builds on this contract rather than duplicating transport. Activity handlers receive a fresh target-aware context whose `send`, `edit`, `delete`, and chat-action methods delegate to the same delivery runtime. The Activity API owns lifecycle normalization; this API owns delivery only.
