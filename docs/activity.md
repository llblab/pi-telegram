# Telegram Activity API

## Purpose

The Telegram Activity API lets trusted extension consumers observe normalized Pi work lifecycle without importing pi-telegram internals, correlating raw Pi events with bridge state, or capturing session contexts.

It is a higher-level event surface over the [Telegram Delivery API](./delivery.md). Activity owns lifecycle normalization and event routing; delivery owns target authorization, rendering transport, ordering, chunk reconciliation, and stale-generation behavior.

The public membrane is:

```ts
import {
  registerTelegramActivityHandler,
} from "@llblab/pi-telegram/activity";
```

An issue #126 consumer can own optional Settings policy for reasoning, intermediate assistant prose, and tool rows. Those visibility choices do not become mandatory bridge-core settings.

## Ownership Boundary

Consumer extension code owns:

- Which activity event classes are visible.
- Settings state and presentation policy.
- Rendering event payloads into operational views.
- Coalescing or replacing its own visible activity documents.
- Redacting additional domain-specific data before display.

pi-telegram owns:

- Mapping Pi lifecycle events into one normalized activity stream.
- Correlating events with the current Telegram turn or Pi instance.
- Stable activity/run identity within one runtime generation.
- Default delivery scope selection.
- Handler registration, ordering, isolation, disposal, and diagnostics.
- Avoiding duplicate provider tool-call versus executed-tool events.
- Session shutdown fencing and fresh delivery contexts.

Pi owns the source lifecycle and provider event protocol. The Activity API requires Pi `0.80.6` or newer because `agent_settled` is the terminal boundary that distinguishes a fully settled activity from automatic retry, compaction, and queued continuation. The API does not invent reasoning when a provider does not expose it.

## Registration

```ts
export interface TelegramActivityHandlerRegistration {
  id: string;
  order?: number;
  handle: (
    event: TelegramActivityEvent,
    ctx: TelegramActivityContext,
  ) => void | Promise<void>;
}

export function registerTelegramActivityHandler(
  registration: TelegramActivityHandlerRegistration,
): () => void;
```

Rules:

- `id` is a stable consumer identity, normally derived from package identity plus a local activity suffix.
- Duplicate active ids are rejected rather than silently stacking duplicate Telegram output.
- Handlers run by `order`, then `id`.
- Registration returns a stale-safe disposer that removes only its own registration.
- Consumers register on `session_start` and dispose on `session_shutdown`.
- The bridge creates a fresh dispatcher generation on every `session_start`; shutdown stops and clears only the retiring generation, so same-process session replacement resumes delivery instead of leaving Activity permanently stopped.
- Handler failures are isolated and recorded in `/telegram-status`; they never break Pi lifecycle or other handlers.

## Activity Identity And Source

```ts
export type TelegramActivitySource =
  | "telegram"
  | "local"
  | "autonomous"
  | "unknown";

export type TelegramActivityTarget = Readonly<TelegramDeliveryTarget>;

export interface TelegramActivityEnvelope {
  activityId: string;
  sequence: number;
  source: TelegramActivitySource;
  target?: TelegramActivityTarget;
  timestamp: number;
}
```

`activityId` identifies one logical settled-work sequence inside the current delivery generation. `sequence` increases monotonically within that activity and lets consumers reject stale asynchronous rendering. Telegram-owned activities carry a frozen `target` captured when the activity starts; it contains only safe chat/thread identity, never a Telegram client or Pi context.

Source classification follows evidence, not guesses:

- `telegram`: a dispatched active Telegram turn exists.
- `local`: the initiating Pi input event reports `interactive` or `rpc` and no Telegram turn owns the run.
- `autonomous`: the initiating input reports `extension` and no Telegram turn owns the run.
- `unknown`: retries, restored continuations, or runtimes without enough input evidence cannot be classified safely.

Automatic retries, overflow compaction retries, and tool continuations inherit the current activity identity/source until `agent_settled`. A new unrelated `agent_start` after settlement allocates a new activity id.

A standalone compaction owns a temporary activity only until `session_compact`. Pi does not expose a sibling-extension cancellation/failure callback after `session_before_compact`, so pi-telegram abandons that temporary identity at the first provable fallback boundary: the next `agent_start`, a replacement compaction start, session shutdown, or the existing five-minute compaction-observer timeout. A late `session_compact` after abandonment is ignored and cannot attach to the next run. Compaction inside an existing agent activity never clears that agent's identity.

## Event Contract

```ts
export type TelegramActivityEvent = TelegramActivityEnvelope & (
  | { type: "agent-start" }
  | {
      type: "assistant-text-delta";
      contentIndex: number;
      delta: string;
    }
  | {
      type: "assistant-segment";
      contentIndex: number;
      text: string;
      placement: "intermediate" | "final" | "terminal-partial";
    }
  | {
      type: "reasoning-delta";
      contentIndex: number;
      delta: string;
    }
  | {
      type: "reasoning-end";
      contentIndex: number;
      text: string;
    }
  | {
      type: "tool-start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool-update";
      toolCallId: string;
      toolName: string;
      update: unknown;
    }
  | {
      type: "tool-end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "compaction-start";
      reason: "manual" | "threshold" | "overflow" | "unknown";
    }
  | {
      type: "compaction-end";
      reason: "manual" | "threshold" | "overflow" | "unknown";
    }
  | { type: "agent-end" }
  | { type: "agent-settled" }
);
```

### Assistant segment classification

Provider stream events expose `text_start`, `text_delta`, and `text_end`, but `text_end` alone does not prove whether prose is intermediate or final. The normalizer therefore holds a completed text segment briefly until the next provider boundary proves placement:

- A following `toolcall_start` classifies the pending text as `intermediate`.
- A following successful `done` classifies it as `final`.
- A following `error` classifies it as `terminal-partial`.
- A new text block flushes any older still-pending segment as `intermediate` only when the provider event order proves another block follows.

`assistant-text-delta` remains available for extensions that want progressive rendering. Consumers that only want complete intermediate prose should ignore deltas and render `assistant-segment` where `placement === "intermediate"`.

### Reasoning

Pi provider events use `thinking_*`; the public product term is `reasoning`. The normalizer maps `thinking_delta` to `reasoning-delta` and `thinking_end` to `reasoning-end`.

- Signed/redacted provider metadata is not exposed as display text.
- Empty reasoning blocks are skipped.
- Providers that hide reasoning produce no reasoning events.
- Consumers must treat reasoning as potentially sensitive and disabled by default.

### Tools

Tool activity uses Pi's executed-tool lifecycle (`tool_execution_start/update/end`), not provider `toolcall_*` payloads. Provider tool-call boundaries are used only to classify preceding assistant prose. This prevents duplicate tool rows and reports actual execution results.

`args`, `update`, and `result` may contain paths, source text, command output, or other sensitive data. They are available to trusted local extension code but must not be rendered wholesale by default. Reference UI should summarize tool name/state and expose bounded details only through explicit policy.

## Delivery Context

```ts
export interface TelegramActivityContext {
  activityId: string;
  sequence: number;
  source: TelegramActivitySource;
  defaultScope: TelegramDeliveryScope;
  send(
    view: TelegramDeliveryView,
    options?: {
      scope?: TelegramDeliveryScope;
      replyToMessageId?: number;
    },
  ): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
  edit(
    handle: TelegramDeliveryHandle,
    view: TelegramDeliveryView,
  ): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
  delete(
    handle: TelegramDeliveryHandle,
  ): Promise<TelegramDeliveryResult<void>>;
  chatAction(
    action: TelegramDeliveryChatAction,
    options?: { scope?: TelegramDeliveryScope },
  ): Promise<TelegramDeliveryResult<void>>;
}
```

Default scope:

- `telegram` uses `{ kind: "target", target: event.target }`, binding delayed handlers to the immutable originating thread rather than whichever turn happens to be active later.
- `local`, `autonomous`, and `unknown` use `{ kind: "instance" }`.

Handlers may explicitly choose aggregate or another authorized scope. Context methods delegate to the public delivery runtime on every call; they do not retain Telegram clients, Pi contexts, or transport ownership objects. The Delivery API rechecks authorization when an operation runs, so a captured target that is no longer owned fails closed instead of rerouting.

A handler may still receive events while no target is currently deliverable. Delivery then returns the normal structured `target-unavailable`, `target-unauthorized`, or `runtime-unavailable` result.

## Dispatch And Backpressure

Pi lifecycle must not wait for extension rendering or Telegram transport.

- Lifecycle hooks normalize and enqueue activity events synchronously, then return.
- Each handler owns a serialized asynchronous queue so its event order is stable without blocking other handlers.
- Handler queues and contexts are generation-bound. `session_shutdown` stops queued events immediately, and an already-running handler receives `runtime-unavailable` instead of delivering through a replacement session after it resumes.
- Disposing a handler also fences contexts captured from that registration; they cannot outlive their ownership and adopt another registration with the same id.
- High-frequency `assistant-text-delta`, `reasoning-delta`, and `tool-update` events may coalesce only with the immediately adjacent event of the same type, activity id, content/tool id, and handler queue.
- Boundary events (`assistant-segment`, `reasoning-end`, tool start/end, compaction, agent end/settled) are never dropped or reordered.
- The 0.21 dispatcher does not impose an event-count drop policy or emit queue-length diagnostics. Adjacent delta/update coalescing reduces common streaming pressure, but boundary events accumulate behind a slow handler; consumers must keep handler work bounded and delegate long-lived work outside the callback when appropriate.

The Delivery API independently serializes concrete Telegram operations per target. Activity serialization preserves semantic event order; delivery serialization preserves transport order.

### Core proactive projection

When `assistant.proactivePush` is enabled, Activity's built-in assistant-output projection uses the same normalized `assistant-segment` boundary exposed to public handlers. It projects every completed public block from `local` or `autonomous` activity, including intermediate commentary/checkpoints and the final block. It never projects text token deltas, reasoning events, tool events or payloads, Telegram-owned activity, unknown-source activity, or empty text.

The projection does not delay Activity dispatch or Pi lifecycle. Its ordered admission tail deduplicates normalized event identity, while existing routing and outbound owners revalidate the immutable admission-time target, profile/token transport generation, direct leader epoch or follower registration generation, and session generation immediately before each send. A replacement or stale owner drops queued work rather than rerouting it. An already-started non-idempotent Bot API mutation follows the normal `commit-unknown` no-replay contract.

This projection consumes ordinary normalized Pi output. It has no runtime dependency on any workflow, loop, or companion extension that produced the public blocks.

## Lifecycle Mapping

The bridge maps Pi hooks as follows:

- `input`: capture source evidence for the next logical activity.
- `agent_start`: allocate or reuse activity identity and emit `agent-start` after Telegram queue consumption establishes active-turn ownership.
- `message_update.assistantMessageEvent`: normalize text/reasoning/provider boundaries.
- `tool_execution_start/update/end`: emit executed tool events.
- `session_before_compact` / `session_compact`: emit compaction boundaries and preserve activity identity across retry compaction; abandon an unterminated standalone compaction at the next lifecycle boundary or observer timeout rather than merging it into another run. A missing or unrecognized reason maps to `unknown` rather than guessing.
- `agent_end`: emit low-level run completion but keep identity alive for retry/follow-up work.
- `agent_settled`: emit terminal settlement, flush pending terminal segments, and release activity identity.
- `session_shutdown`: stop dispatch, clear pending normalization state, and invalidate delivery generation through the existing delivery lifecycle.

## Diagnostics

Duplicate registration fails synchronously. When a handler throws or rejects, the dispatcher forwards only the handler id, event type, activity id, and error to pi-telegram's existing bounded/redacted runtime event recorder. The bridge does not copy reasoning, assistant prose, tool arguments/results, Telegram payloads, or queue contents into diagnostic metadata. It does not currently record queue phase, queue length, coalescing counts, or handler latency.

The first implementation has no public Activity diagnostics getter because handler failures already flow through bridge runtime diagnostics and `/telegram-status`. Add queue telemetry or a dedicated getter only when an observed consumer needs inspectable backpressure state.

## Security And Non-Goals

The Activity API does not:

- Enable reasoning visibility by default.
- Guarantee reasoning availability across providers.
- Expose signed/redacted reasoning metadata.
- Render raw tool arguments or results automatically.
- Replace assistant final replies or Rich Draft previews.
- Mutate queues, models, thinking levels, sessions, or process state.
- Expose Telegram clients, bot tokens, Pi contexts, or private runtime objects.
- Block Pi lifecycle on extension handlers or Telegram delivery.

## Validation Contract

The implementation must cover:

- Stable id registration, ordering, duplicate rejection, and stale-safe disposal.
- Telegram, local, autonomous, and unknown source evidence.
- Identity reuse across retry/compaction and reset at settlement.
- Text delta flow and intermediate/final/terminal segment classification.
- Reasoning mapping and empty/hidden reasoning behavior.
- Executed tool start/update/end without provider tool-call duplication.
- Default active-turn versus instance delivery scopes.
- Adjacent delta/update coalescing and boundary preservation.
- Handler error isolation, non-blocking lifecycle, shutdown fencing, and redacted diagnostics.
- Public package import without `/lib` reach-through.

## Consumer Policy Pattern

The registration and delivery examples above provide the complete public building blocks for issue #126-style visibility policy:

- Reasoning can default off and send completed `reasoning-end` blocks only when enabled.
- Intermediate prose can default off and send only `assistant-segment` events with `placement: "intermediate"`, never the final assistant segment.
- Tool rows can default on, show only tool name/state, and edit generation-bound logical handles from running to done/failed without exposing arguments or results.
- Interactive toggles belong in a registered Section and Settings row; activity messages can remain non-interactive.
- `session_shutdown` should dispose stable registrations and drop retained delivery handles, so reload/session replacement cannot reuse old contexts or handles.

The separate [`pi-telegram-extension-demo`](https://github.com/llblab/pi-telegram-extension-demo) project remains the maintained companion-extension and managed-UI reference. This document owns the Activity-specific usage pattern; pi-telegram does not ship a redundant `examples/` package directory.
