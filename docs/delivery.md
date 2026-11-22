# Telegram Delivery API

## Purpose

The Telegram Delivery API gives trusted extension consumers a safe programmatic way to render operational Telegram UI and deliver bounded producer-approved documents without importing bridge internals or owning Telegram transport.

It fills the boundary between callback-scoped `TelegramSectionContext.open()` and agent-callable `telegram_message` / `telegram_attach`. It does not replace normal active-turn final replies, Sections, outbound handlers, or raw update handlers.

The public package membrane is:

```ts
import {
  deleteTelegramView,
  editTelegramView,
  openTelegramTaskView,
  sendTelegramArtifact,
  sendTelegramChatAction,
  sendTelegramView,
} from "@llblab/pi-telegram/delivery";
```

## Agent Markup Is A Separate Surface

Agents author [selection markup](./public-api.md#agent-selection-markup) in ordinary final replies. Confirm/Choice clicks use the existing `telegram_button` action store, selection feedback and ordinary prompt queue; they do not call these SDK functions or hold a model tool open. Single answers deliver bare question/answer JSON; exact-N Choice toggles locally and delivers one label array only at completion. Choice arrays advance locally through one current question at a time, preserving the composed one-message view, and deliver one ordered question/answer array at completion. No new Confirm/Choice/Task/Artifact agent tools are registered. Companion-extension SDK contracts below remain separate.

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

`replyMarkup` accepts only structural keyboard data. Arbitrary callback ownership stays with Sections or a registered raw update handler. Explicit binary questions use [`openTelegramConfirm()`](./public-api.md#confirm-api-unreleased) on this same Delivery runtime: pending answers share its generation, target policy and ordering rather than introducing a second managed callback registry. The producer retains operation semantics and execution authority; this narrow capability does not turn arbitrary delivered buttons into managed actions.

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
- `instance` resolves the current process's assigned follower/leader Thread, or the paired private chat in Classic Mode. In Threaded Mode, a missing assigned Thread returns `target-unavailable`; it never falls back to All or another instance.
- `aggregate` resolves the paired private chat only in Classic Mode. In Threaded Mode, `All` is input-only: aggregate sends return `target-unavailable`, and even retained follower aggregate markers cannot authorize an All write.
- `target` validates an explicit destination against the active profile and current runtime authority. A Classic owner may target its paired private chat. A Threaded follower may target only its assigned Thread; a leader may target its own or another currently live bound Thread. Explicit threadless targets, unknown, stale, cross-profile, and unpaired targets are rejected.

No scope selects another named profile. Profile activation remains session-local bridge state.

Threaded Mode applies to active-turn output and edits through retained Classic handles too. The Bot API client rejects new positive private-chat sends, copies, forwards, drafts and chat actions without a positive safe-integer top-level `message_thread_id`, before transport/file access and again at asynchronous/retry authority boundaries. Reply anchors and caller guards cannot substitute a Thread target. Classic DM, explicit channel destinations, business namespaces, callback answers and deletion remain distinct. The extension does not auto-clean historical All output.

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

### Task Projection (Unreleased)

`openTelegramTaskView()` returns one producer-owned progress projection with `update`, `close`, a local lifetime `result` and a separate advisory `cancellation` promise. It reuses this runtime's logical handles, target serialization, native transport and pending-interaction limit. It neither executes work nor interprets cancellation as a global Pi abort. Progress is explicitly producer-reported, optional and coalesced; terminal intent excludes new cancellation/update attempts. Failed/uncertain edits retire the view, while cleanup failure cannot change its local outcome. Reload invalidates controls without restoring a business task. See the exact [Task View public contract](./public-api.md#task-view-api-unreleased) and [internal ownership](./architecture.md#task-view-unreleased). Whole-release and live acceptance remain separate.

### Artifact Output (Unreleased)

[`sendTelegramArtifact()`](./public-api.md#artifact-delivery-contract-unreleased) sends one bounded caller-selected document through this same Delivery owner. It is implemented and exported locally, not in released 0.58.3 or activated in the running session. Direct and authenticated follower source/native and compiled-native fixtures passed locally; supported-platform and live acceptance remain separate. A distinct singular document receipt must not be treated as a text-view handle. File-read/disclosure/business authorization remains producer-owned, and uncertain publication never permits automatic resend.

```ts
const delivered = await sendTelegramArtifact({
  owner: "@example/export",
  scope: { kind: "instance" },
  file: { path: approvedAbsolutePath, name: "report.json" },
  caption: "Exported report",
  timeoutMs: 30_000,
  signal,
});
if (!delivered.ok) return; // Unknown publication is not permission to retry.
// delivered.receipt identifies the document, not business completion.
```

The [internal vertical](./architecture.md#artifact-delivery-unreleased-bounded) uses private descriptor-based byte capture, original binding/route/turn/session/transport authority, capability-gated authenticated follower transport, incarnation-aware memoization and bounded actual-work resource lifetimes. Capture is limited to 1 MiB or a lower configured limit, with one outstanding operation per Delivery runtime and one shared native-client slot for leader direct/follower work. A finite deadline and required abort signal do not release resources before actual cleanup. It adds neither a generic media factory nor an outbound consumer lease. Existing views, Sections and generic `telegram_attach` behavior are unchanged.

## Runtime Binding

The public functions resolve a process-local runtime binding on every call. They never capture a Pi `ExtensionContext` or command context.

The bridge constructs and binds a genuinely fresh delivery runtime during every `session_start`. It unbinds and shuts down the current runtime during `session_shutdown` before session-bound transport state is discarded; binding an unexpected replacement also shuts down the displaced runtime. Native transport/registration and leader-target notifications additionally replace a runtime whose original local authority ended, including equal-field follower re-registration. Repeated notifications for the same still-current native owner preserve questions and handles. An initially unavailable owner can become a fresh runtime only from a new native capture; late notifications after shutdown cannot restart one. A legacy local registration lifetime grants neither remote publication proof nor Artifact/private-input readiness. Root additionally coordinates bounded direct SDK/agent questions with the original publisher/native registry scope and [bounded follower plain/native-app first sends](./architecture.md#follower-question-birth-and-plain-first-send-root-bounded) with original local SDK/bot/provider scope plus acknowledged API registration and complete native Message evidence; app frames additionally retain original native app authority and complete rosters; mixed frames require one original native result binding across every question and bound row. Capture precedes publication; an ACK cannot acquire a successor. When that provenance is unavailable, SDK questions remain independent rather than becoming unavailable. Bounded direct and follower original-source first-send app questions now carry original native app capture. Selection remains independently fenced by its original producer/app scope if SDK membership ends or is unavailable; that is not permission to borrow a new SDK owner. [Bounded follower plain known-parent Text/Rich and keyboard-only markup edits](./architecture.md#follower-plain-known-parent-edit-root-bounded) now also retain complete original SDK parent rosters and the actual native edit Message; omitted request Thread derives only from that parent. [Native remote callback feedback](./architecture.md#follower-callback-feedback-root-native-parent-membership-held) separately joins the actual edit Message, API non-refusal and the captured parent location, preserving valid original worker/result execution without opening app-parent membership. The [first read-only app callback child](./architecture.md#follower-read-only-app-callback-child-root-bounded) now has a separate join for complete original feedback/invocation/first-parent evidence, not a general app edit policy. [Pure-question children](./architecture.md#follower-pure-question-callback-child-root-bounded) reuse captured native question origins for that same exact successor; no dummy control or fresh ACK-time owner is needed. [Queued-native-feedback children](./architecture.md#follower-queued-native-feedback-child-root-bounded) retain that exact source while waiting for original feedback I/O; an SDK admission before child native ACK still withholds membership. The [bounded deferred join](./architecture.md#follower-deferred-native-feedback-child-root-bounded) instead captures the cohort at that ACK, waits for the same original editor and retains at most one authenticated later admission ceiling. It exposes no pending head and cannot renew the clock at settlement or adopt a replacement SDK owner. [One producer-backed retained original group](./architecture.md#follower-one-retained-original-group-root-bounded-native-rich) now preserves its original selection, birth/deadline and first publisher through that native Rich path; the explicit main-side fixture does not establish standalone retention intent or a public discovery API. Unsupported general app-parent, follower unproved mixed/retained/edit-first/non-superseding markup and incomplete-carrier histories do not enter the new common cohort. Reload, session and native-owner replacement therefore produce these outcomes:

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
- Leader own-Thread and live-bound explicit target resolution; no All fallback on target loss.
- Follower assigned-Thread routing through the leader; no aggregate-marker escape.
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
