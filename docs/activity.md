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

An external consumer can own optional Settings policy for reasoning, intermediate assistant prose, and tool rows. Those visibility choices do not become mandatory bridge-core settings.

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

A standalone compaction owns a temporary activity until `session_compact` or `session_compact_failed`. Native failure or cancellation immediately abandons that identity, clears compacting state, releases deferred queue work, and stops observer-owned typing; the five-minute observer timeout remains a compatibility fallback for a host that never emits a terminal compaction event. A late `session_compact` after abandonment is ignored and cannot attach to the next run. Compaction inside an existing agent activity never clears that agent's identity.

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
  | {
      type: "ui-prompt-start";
      kind: "select" | "confirm" | "input" | "editor" | "custom";
      title?: string;
    }
  | { type: "ui-prompt-end" }
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

`args`, `update`, and `result` may contain paths, source text, command output, or other sensitive data. They are available to trusted local extension code but must not be rendered wholesale by default. Core `quiet` mode renders none of them. Visible tool modes redact known secret shapes, truncate every evidence field, and place completed tool evidence in native Rich Messages with an open-by-default `arguments` child plus closed `update`/`result`/`error` details; child summaries use lowercase monospaced labels without icons, list markers, or heading emphasis, like quote-free outer JSON keys, while their evidence remains in JSON pre blocks.

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

Handlers may explicitly choose an authorized scope; aggregate output is available only in Classic Mode, never Threaded Mode's input-only All. Context methods delegate to the public delivery runtime on every call; they do not retain Telegram clients, Pi contexts, or transport ownership objects. The Delivery API rechecks authorization when an operation runs, so a captured target that is no longer owned fails closed instead of rerouting.

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

### Core assistant-output projection

Activity's built-in assistant-output projection uses the same normalized `assistant-segment` boundary exposed to public handlers. For `telegram` activity it always projects complete `intermediate` commentary to the immutable originating target, while final and terminal-partial segments remain with active-turn settlement. For `local`, `autonomous`, or unclassified extension follow-up activity, every completed public block—including intermediate commentary/checkpoints and the final block—is projected whenever this Pi instance retains authorized connected transport. This closes actor-follow-up delivery without reclassifying it as direct user input, and the connected companion contract has no projection opt-out. It never projects text token deltas, reasoning events, tool events or payloads, or empty text.

The projection does not delay Activity dispatch or Pi lifecycle. Its ordered admission tail deduplicates normalized event identity, while existing routing and outbound owners revalidate the immutable admission-time target, profile/token transport generation, direct leader epoch or follower registration generation, and session generation immediately before each send. Active-turn final delivery waits for admitted commentary inside its existing background task. A replacement or stale owner drops queued work rather than rerouting it, and an already-started non-idempotent Bot API mutation follows the normal `commit-unknown` no-replay contract.

This projection consumes ordinary normalized Pi output. It has no runtime dependency on any workflow, loop, or companion extension that produced the public blocks.

## Lifecycle Mapping

The bridge maps Pi hooks as follows:

- `input`: capture source evidence for the next logical activity.
- `agent_start`: allocate or reuse activity identity and emit `agent-start` after Telegram queue consumption establishes active-turn ownership.
- `message_update.assistantMessageEvent`: normalize text/reasoning/provider boundaries.
- `tool_execution_start/update/end`: emit executed tool events.
- `session_before_compact` / `session_compact` / `session_compact_failed`: emit successful compaction boundaries, abandon failed or cancelled work immediately, and preserve activity identity across retry compaction. Mid-run threshold compaction stays between tool results and the next assistant response, while terminal assistant output awaiting transport keeps later notices behind its final reply. A missing or unrecognized reason maps to `unknown` rather than guessing.
- `ui_prompt_start` / `ui_prompt_end`: emit one coalesced waiting span for extension-owned local UI, pause Telegram typing while Pi waits for the operator, and resume typing when the prompt closes if agent or compaction work remains unsettled.
- `agent_end`: emit low-level run completion but keep identity and connected work presence alive for retry, compaction, or follow-up work.
- `agent_settled`: emit terminal settlement, flush pending terminal segments, release activity identity, and end agent-owned connected work presence.
- `session_shutdown`: stop dispatch, clear pending normalization state, and invalidate delivery generation through the existing delivery lifecycle.

## Diagnostics

Duplicate registration fails synchronously. When a handler throws or rejects, the dispatcher forwards only the handler id, event type, activity id, and error to pi-telegram's existing bounded/redacted runtime event recorder. The bridge does not copy reasoning, assistant prose, tool arguments/results, Telegram payloads, or queue contents into diagnostic metadata. It does not currently record queue phase, queue length, coalescing counts, or handler latency.

The first implementation has no public Activity diagnostics getter because handler failures already flow through bridge runtime diagnostics and `/telegram-status`. Add queue telemetry or a dedicated getter only when an observed consumer needs inspectable backpressure state.

## Security And Non-Goals

The Activity API itself does not:

- Enable reasoning visibility by default.
- Guarantee reasoning availability across providers.
- Expose signed/redacted reasoning metadata.
- Render raw tool arguments or results for public handlers automatically. The separate bridge-owned verbose projector renders only bounded redacted evidence after explicit operator opt-in.
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

## Core Verbosity And Consumer Policy

The bridge owns a global `quiet`/`thinking`/`tools`/`verbose` policy. `verbose` is the absent-config default, `thinking` and `tools` select one technical class, and `quiet` disables both. Available thinking uses persistent ordinary HTML with an expandable blockquote; bounded tool evidence uses native Rich details without changing public assistant-segment projection or final replies.

The registration and delivery examples above remain the public building blocks for companion-specific policy:

- Companion reasoning must still default off unless its own explicit policy enables it.
- Intermediate prose can default off and send only `assistant-segment` events with `placement: "intermediate"`, never the final assistant segment.
- Companion tool rows should avoid duplicating the core verbose projection and must retain their own generation-bound handles and disclosure policy.
- Interactive toggles belong in a registered Section and Settings row; activity messages can remain non-interactive.
- `session_shutdown` should dispose stable registrations and drop retained delivery handles, so reload/session replacement cannot reuse old contexts or handles.

### Optional Work-Start Notices

Native typing is best-effort and its visibility depends on the Telegram client. An optional companion can send one fixed notice at `agent-start` and remove its own message at `agent-settled`. Core does not enable this notice automatically; `quiet` continues to hide reasoning and tool evidence.

Save this example as a Pi extension and load it alongside `pi-telegram` to opt in. The message stays through tool execution, retries and in-run compaction. Standalone compaction does not create a notice, and event payloads are never rendered. The public APIs retain default context scopes and handle authorization.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramActivityHandler } from "@llblab/pi-telegram/activity";
import type { TelegramDeliveryHandle } from "@llblab/pi-telegram/delivery";

export default function workStartNotice(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;
  pi.on("session_start", () => {
    dispose?.();
    dispose = undefined;
    let active = true;
    const activities = new Map<string, { handle?: TelegramDeliveryHandle }>();
    const unregister = registerTelegramActivityHandler({
      id: "example/work-start-notice",
      async handle(event, ctx) {
        if (!active) return;
        if (event.type === "agent-start") {
          if (activities.has(event.activityId)) return;
          const owner: { handle?: TelegramDeliveryHandle } = {};
          activities.set(event.activityId, owner);
          const result = await ctx.send({
            text: "<b>⏳ Work started.</b>",
            parseMode: "html",
          });
          if (active && activities.get(event.activityId) === owner) {
            owner.handle = result.ok ? result.value : result.partial;
          }
        } else if (event.type === "agent-settled") {
          const owner = activities.get(event.activityId);
          activities.delete(event.activityId);
          if (owner?.handle) await ctx.delete(owner.handle);
        }
      },
    });
    dispose = () => { active = false; activities.clear(); unregister(); };
  });
  pi.on("session_shutdown", () => { dispose?.(); dispose = undefined; });
}
```

The notice acknowledges that work started; it is not a liveness probe or proof of final-reply delivery. Transport failures, shutdown during a send, or a process crash can leave a notice behind. Discard old handles on shutdown instead of bypassing generation fencing to clean them up. Failed or ambiguous sends are not replayed; a returned partial handle is retained for normal settlement cleanup. Send and delete failures use the existing delivery diagnostics.

An ordinary notice can generate an extra notification because the current public view API has no silent-send option. This recipe does not change the client's native typing renderer.

The separate [`pi-telegram-extension-demo`](https://github.com/llblab/pi-telegram-extension-demo) project remains the maintained companion-extension and managed-UI reference. This document owns the Activity-specific usage pattern; pi-telegram does not ship a redundant `examples/` package directory.
