# Generative Apps Runtime For Telegram

_Status: incremental implementation. Canonical installation and explicit transactional replacement, agent-side method invocation, state/history commits, partial-tail recovery, cross-process transition locking with dead-owner recovery, installation-generation plus revision rejection for direct app-output controls, lifecycle-cancelled worker-isolated methods, the bounded non-shell process port, strict bound-action parsing, pre-model-queue `tgbtn` dispatch, new-message default views, opt-in in-place bound-action edits with explicit-action send fallback, and memory-only live dashboards with bounded scheduling, same-handle action rescheduling, Delivery failure classification, exact routed-target retention, unavailable-message invalidation, and lifecycle cancellation are implemented locally. Agent-mediated initial-surface revision capture, process-birth lock proof, voice delivery, and removal remain open in the backlog._

## Purpose

This document specifies the concrete Generative App runtime implemented by `pi-telegram`. The transport-independent concept, vocabulary, application shapes, hybrid action model, and agent operating workflow belong to the bundled [`generative-apps` Skill](../skills/generative-apps/SKILL.md).

The Telegram implementation provides managed installation, method execution, persistence, button binding, callback routing, and message delivery:

```text
Telegram control → bound method → state/capability owner
Telegram view    ← rendered output ← fresh result
```

This runtime coexists with ordinary prompt buttons, companion-extension callbacks, Sections, and the Delivery API. It ships no application catalog or `examples/` tree; reusable domain scripts remain with their capability owners.

## Ownership Split

- The bundled [`generative-apps` Skill](../skills/generative-apps/SKILL.md) owns the general concept and agent operation: category definition, `generated` versus `generative`, application shapes, hybrid method/prompt surfaces, selection, authorship, review, workflow, safety, and validation judgment.
- [`architecture.md`](./architecture.md#generative-apps) owns this runtime's place inside the Telegram bridge and its domain boundaries.
- This document owns only `pi-telegram` implementation contracts: canonical managed identity, executable ABI, Telegram wire syntax, state timeline, installation/replacement, bounded ports, callback routing, delivery, lifecycle, and current limitations.
- [`generated-control-surface`](../skills/generated-control-surface/SKILL.md) owns the separate ephemeral control-surface operating protocol.

Keep conceptual guidance out of this document and Telegram runtime mechanics out of the Generative Apps Skill.

## Canonical Layout And Identity

Generative Apps live under the active Pi agent directory, never in package installation files or temporary storage:

```text
<agent-dir>/genapps/
└── poker/
    ├── poker.mjs
    ├── state.json
    └── states.jsonl
```

Identity is structural:

```text
app = directory name = module stem
poker  = poker          = poker.mjs
```

No app manifest, per-app `package.json`, duplicated `name`, class registration, or default export is required. The `.mjs` extension supplies ESM semantics directly.

An app name is a unique lowercase ASCII identifier accepted by the runtime's path-safe validation. It must not contain path separators, `..`, `::`, or a native callback namespace delimiter.

## Inference-Bypass Syntax

Compact Matrix Literal and full JSON buttons keep their existing `label + prompt` contract. App output may use hidden `telegram_button` comments for footer controls or standalone triple-backtick `telegram_button` blocks between paragraphs; both singleton cells and mixed matrices retain the same generation/revision-bound routing. In-body controls acknowledge clicks without recoloring the message; HTML compatibility moves them to the footer. A bound action is encoded entirely in the prompt string:

```ebnf
bound-action = app "::" method [ "(" json-value ")" ]
```

Examples:

```text
poker::fold
poker::call(18)
poker::init({"seed":"abc"})
media::seek("+30s")
```

No argument means no decorative empty parentheses. One optional argument is a strict JSON value; the runtime never evaluates JavaScript source from the argument.

CML:

```text
[{Fold|poker::fold}{Call 18|poker::call(18)}]
```

Equivalent JSON:

```json
[
  [
    { "label": "Fold", "prompt": "poker::fold" },
    { "label": "Call 18", "prompt": "poker::call(18)" }
  ]
]
```

`app` is not a button property. Both representations normalize to the same prompt string, and routing happens afterward. The shared [button grammar](./compact-matrix-literal.md) also supports disabled controls: `{Call|||1}` or JSON `{"label":"Call","disabled":true}`. A disabled cell needs no method prompt or selected style; `{|||1}` is an intentional blank disabled cell. These remain visible but register no callback or bound action. App methods must still validate current state when invoked through an enabled control or another supported entrypoint; disabled presentation is not an authorization boundary.

The double colon is the inference-bypass operator: it routes a generated prompt control to a registered deterministic owner before Pi queue admission. Native extension callbacks retain their existing single-colon grammar:

```text
myext:action:payload   native callback_data namespace
poker::call(18)        generated prompt routed to a Generative App
```

These routes do not conflict. Native callbacks are direct by construction. `::` exists only because an ordinary generated button prompt would otherwise enter the model queue.

An absent, stale, or invalid bound app fails closed and never degrades into an accidental model prompt.

## `telegram_bind` Tool

One agent Tool owns installation and deliberate invocation through two mutually exclusive shapes. Its optional `argument` schema explicitly describes JSON values (`null`, boolean, number, string, array, or object) as a bounded union nested four container levels deep rather than using an unconstrained subschema. Pi keeps the same JSON semantics, while schema aggregators cannot lower this field to a bare `true` schema that some llama-server grammars reject. The union is built through standard schema builders and serialized inline with no `$ref`/`$defs` recursion, so provider tool APIs that reject recursive or reference-resolved schemas (OpenAI) accept it alongside providers strict about unknown schema fields (Gemini).

Install an external self-contained module and initialize it:

```ts
telegram_bind({
  app: "poker",
  script: "/path/to/poker.mjs",
  argument: { seed: "abc" }
})
```

The runtime copies the module to `<agent-dir>/genapps/poker/poker.mjs`, validates the canonical identity and required exports, transactionally invokes `init(argument)`, and initializes state. Existing installation is never overwritten without explicit replacement authority. Installed canonical modules are discovered directly when a bound action resolves; there is no separate app registry.

Explicitly replace an installed app after editing its script:

```ts
telegram_bind({
  app: "poker",
  script: "/path/to/poker.mjs",
  replace: true,
  argument: { seed: "abc" }
})
```

Replacement validates and initializes a complete staging app before publishing it under the existing app name. A failed `init` preserves the installed module, state, and timeline. Omitting `replace: true` keeps duplicate installation fail-closed, while setting it for an absent app also fails instead of silently changing replacement into installation.

Discover or reuse an app already written at its canonical path and invoke a named method:

```ts
telegram_bind({
  app: "poker",
  method: "init",
  argument: { seed: "abc" }
})
```

Agent-side diagnostic invocation uses the same shape:

```ts
telegram_bind({ app: "poker", method: "inspect" })
```

`script` and `method` are mutually exclusive, and `replace` is valid only with `script`. Script installation or replacement implicitly invokes mandatory `init`; existing-app invocation names its method explicitly. Folder presence supplies durable discoverability across runtime replacement without introducing a manifest.

During an active Telegram turn, `telegram_bind` displays successful app output directly through the current outbound planner and exact turn target by default, including initial `init` output; its Tool result tells the agent not to repeat or reformat the delivered view. Set `display: false` for agent-only diagnosis. Outside an active Telegram turn, the Tool returns bounded output for exact caller-owned presentation rather than choosing a Telegram target implicitly. The same method invoked through `app::method(argument)` routes its rendered output directly to the owning Telegram surface.

## Module Contract

A Generative App exports plain named async or synchronous functions. `init` is mandatory. Classes and default exports are outside the contract.

```js
export async function init({ argument, run, signal }) {
  const seed = argument?.seed ?? "default";
  return {
    state: { seed, turn: 0 },
    output: "**Ready**\n\n<!-- telegram_button {Start|poker::start} -->"
  };
}

export async function start({ state }) {
  const nextState = { ...state, turn: state.turn + 1 };
  return {
    state: nextState,
    output: `**Turn:** \`${nextState.turn}\``
  };
}

export async function inspect({ state }) {
  return { output: JSON.stringify(state) };
}
```

The runtime context may contain only bounded capabilities required by the contract:

- Current immutable app state, absent for first initialization.
- Parsed optional JSON argument.
- Cancellation signal and current app revision.
- A bounded non-shell process port for coherent CLI adapters.
- Redacted app/target metadata needed for diagnostics and rendering ownership.

The runtime does not pass a raw Telegram client, bot token, Pi extension context, arbitrary transport operation, or mutable queue/session state.

A method result contains:

```ts
interface GenerativeAppResult {
  state?: JsonValue;
  output: string;
  viewMode?: "new" | "edit";
  refreshAfterMs?: number;
}
```

`output` is ordinary assistant Markdown plus existing top-level voice/button markup. It passes through the established outbound planner rather than defining a second rendering language. Omitted `viewMode` defaults to `"new"`: the result arrives as a fresh message and the clicked button remains visibly selected on its prior surface. `viewMode: "edit"` opts one result into replacing the callback message and keyboard in place when Telegram permits it; edit failure after that explicit action may fall back to one new message.

Returning `state` requests a committed transition. Omitting `state` makes the method output-only, which supports inspection and live refresh without appending duplicate history. `refreshAfterMs` is an optional finite positive integer scheduling hint: on a successfully delivered explicit frame it opens or reschedules that logical surface, while omission closes any existing schedule for that surface. The exported `refresh` method itself must be output-only; returning `state` from `refresh` fails before state or Telegram effects commit. Invalid, oversized, non-serializable, or malformed results fail before state or Telegram effects commit.

## Current State And State Timeline

`state.json` is the compact current projection read by the runtime and, when useful, by the agent:

```json
{
  "seed": "abc",
  "turn": 2
}
```

`states.jsonl` is the committed-state timeline. Its first line is the successful initial state; each later state-changing method appends one complete snapshot envelope:

```jsonl
{"revision":0,"method":"init","argument":{"seed":"abc"},"state":{"seed":"abc","turn":0}}
{"revision":1,"method":"start","state":{"seed":"abc","turn":1}}
{"revision":2,"method":"start","state":{"seed":"abc","turn":2}}
```

The state in `state.json` equals the state in the latest complete journal line. Runtime-owned locking, revision checks, complete-line append, atomic replacement, and recovery preserve that relation across concurrent clicks and interruption. A partial final JSONL line is never treated as committed state.

A successful `init` is a hard new-run boundary. It transactionally clears current state and prior history, writes the new initial snapshot as revision zero, and publishes the initial output. Initialization failure preserves the previous working state and journal unchanged.

Application state is the app's complete persistent checkpoint: it includes interaction/configuration state plus the latest normalized external projection needed to render, diagnose, or reconstruct the current view. An agent reading `state.json` should be able to identify material app reality such as selected track, playback state, queue position, backend, and last observation without executing the app first. This projection is explicitly a last-observed cache, not the external domain authority: before a mutation, explicit status, or refresh, a CLI-backed app re-reads the actual owner, then commits a new complete snapshot only when retained app state materially changes.

## CLI Capability Adapters

A Generative App may compose several existing CLI tools when they belong to one coherent domain or user journey:

```text
media Generative App → playerctl + mpv + local media library
git Generative App   → git + gh
actors Generative App → documented Actor runtime capabilities
```

A bounded process port uses executable plus argument arrays, an explicit working directory, output limits, timeout, cancellation, and redacted evidence. Shell interpolation is not the default contract.

```js
const result = await run({
  command: "playerctl",
  args: ["metadata", "--format", "{{artist}} — {{title}}"],
  timeoutMs: 10_000
});
```

A generic `exec(arbitrary-shell-command)` Generative App is forbidden. It would turn Telegram into a remote terminal, bypass bounded capability ownership, and violate the mobile companion boundary. A direct button click authorizes only the installed app method and its validated argument, never arbitrary process execution.

## Live Views

A Generative App sends a new message after a successful bound user action by default. This simple mode preserves prior surfaces and their visibly selected buttons, is robust across ordinary Telegram constraints, and remains a first-class behavior rather than a fallback to eliminate. A method may opt into `viewMode: "edit"` to replace the callback message and keyboard in place; if that explicit action cannot edit a deleted or otherwise unavailable message, it may send one fresh view because the click itself supplies recreation authority.

The memory-only scheduler kernel is implemented, including non-overlap, digest suppression, lifecycle checks, cancellation, and bounded retry timing. Session shutdown synchronously cancels and forgets every live surface before the composed transport lifecycle stops; replacement of the registered runtime does the same. A successful explicit `telegram_bind` delivery with `refreshAfterMs` now attaches its generation-fenced logical Delivery handle to that scheduler, starts a production timer, plans each changed refresh through the complete outbound Markdown/button planner, and edits through Delivery. Omission of the next hint renders the final changed frame and then closes the schedule. Bound-action rescheduling, Delivery edit-failure classification, lifecycle cancellation, direct classic/leader/authenticated-follower routed-target regressions, and known unavailable-message invalidation with bounded classified diagnostics are implemented. Bot API assessment found no applicable ordinary private-message deletion update. The broader package regression suite now passes with the live-view invariants below, so live dashboards are locally release-complete within that platform boundary:

```js
export async function refresh({ state, run }) {
  return {
    output: await renderPlayer(state.player, run),
    refreshAfterMs: 5000
  };
}
```

The runtime contract is:

- A successfully delivered explicit app frame with `refreshAfterMs` opens one live surface and replaces any older live surface for the same `{ app, profile, target }`; surface identity is the exact delivery generation and Telegram message handle, not app state or a durable manifest.
- The installed module must export `refresh`. The scheduler invokes only that named method with the latest committed state and expected installation generation/revision; `refresh` is output-only and cannot advance the state timeline.
- A missing hint on an explicit action or refresh result closes that surface. A malformed, non-finite, non-positive, or non-integer hint rejects the method result. Values below two seconds clamp to two seconds; values above 24 hours clamp to 24 hours.
- The next timer starts only after the prior method, planning, and Telegram edit settle. One in-flight tick exists per surface; ticks never overlap, queue, or catch up.
- The frame digest covers normalized planned Markdown plus the normalized inline keyboard, including both in-body and footer `telegram_button` controls. An unchanged digest performs no Telegram call but still honors the returned next hint.
- An explicit bound action on the current live-surface message cancels its pending timer and takes surface ownership before invocation. Any refresh continuation returning after that take, cancellation, or same-key replacement is identity-fenced before planning or editing and cannot cancel the replacement. A successful action result carrying a hint edits and reschedules that same logical surface regardless of `viewMode`; omission closes it. Actions on other messages retain the ordinary `viewMode` contract and may open a replacement live surface only after successful delivery.
- Telegram flood-control `retry_after` delays the same pending frame without re-invoking app code. Other retryable edit failures use `2s → 4s → 8s → 16s → 32s → 60s` bounded exponential backoff with one retained latest frame; no retry may outlive surface authority. Ambiguous edit outcomes are diagnosed and stop the surface rather than replaying blindly.
- Known message-not-found/deleted failures, app replacement/removal, target/profile/session generation loss, runtime shutdown, or execution-fence loss cancel and forget the surface. Refresh is memory-only and never resumes after process replacement until an explicit frame opens it again.
- Direct-leader and authenticated-follower delivery use the existing routed transport authority. The surface owner stores no bot token/client and checks exact profile, target, transport generation, app installation generation, state revision, and runtime generation immediately before invocation and edit.

The runtime retains one private live-surface record per `{ app, profile, target }`: handle, app generation/revision, runtime and transport fences, normalized frame digest, next due time, retry state, and cancellation controller. This registry belongs to the Generative Apps runtime; the composition root supplies narrow plan/edit/classify-error ports. It reuses the logical delivery-handle contract but does not make surfaces durable or move scheduling into the general Delivery API.

Telegram's Bot API `Update` exposes deletion only as `deleted_business_messages` for messages from a connected business account; it exposes no deletion update for ordinary private bot messages. Generative App surfaces therefore cannot safely wire proactive deletion invalidation in the supported private-DM runtime. When an edit returns a known message-not-found result, the runtime records one bounded event with phase, app, and classified outcome, forgets the handle, and stops refresh without re-invoking app code. It never recreates a user-deleted view automatically; the next explicit user action or app opening may create a fresh view.

## Lifecycle And Safety

Generative Apps are trusted local code and therefore an explicit capability grant, not a sandbox promise. The runtime still narrows accidental authority and operational failure:

- Installation validates canonical paths and rejects traversal, symlinks outside the managed root, identity mismatch, and silent replacement; explicit replacement stages and initializes the new app before swapping it under the same app.
- App execution cannot own Telegram polling, credentials, raw transport, Pi queue state, or another app's files through the provided contract.
- Per-app transitions serialize and compare immutable installation generation plus state revision so stale buttons cannot cross replacement or mutate newer state.
- State commit and Telegram effect ordering are explicit; ambiguous non-idempotent transport outcomes never replay blindly.
- Time, output, state-size, refresh-rate, and process bounds prevent one app from monopolizing the extension.
- Session/profile/target generation replacement makes old scheduled work inert.
- Diagnostics redact secrets and preserve app name, method, revision, failure class, and bounded stderr/result evidence.
- Removal cancels refresh, invalidates the live binding, and keeps destructive state deletion as a separate explicit operation.

## Application Roles

The runtime supports two ownership roles without shipping application templates:

- A standalone deterministic app owns its complete application state and transition rules. Poker-like games are the reference shape for app-owned state, not a bundled catalog entry.
- A view/controller adapter owns only validated adapter configuration and a last-observed projection. A music-player remote is the reference shape: the Actor remains authoritative, while the Generative App samples structured status, invokes bounded controls, and renders the next view.

Both roles use the same module, state, bound-action, and safety contracts. Selection and authoring procedure belong to the bundled `generative-apps` Skill.

## Validation Contract

Implementation is not complete until evidence covers:

- Canonical path identity, direct app discovery, copy/install, explicit replacement with failure preservation, removal, and traversal rejection.
- Mandatory `init`, named method dispatch, no-argument and strict-JSON argument parsing, missing exports, and result validation.
- Transactional initialization, state/history equality, concurrent/stale actions, partial journal recovery, and output-only methods.
- CML and full JSON button equivalence, inference bypass before Pi queue admission, absent-owner failure, and unchanged native callback routing.
- Direct classic, leader, and follower target delivery with generation fencing and no model turn.
- CLI process timeout, cancellation, output bounds, stderr diagnostics, and arbitrary-shell rejection.
- Live-view handle retention, unchanged-frame suppression, two-second minimum, non-overlap, coalescing, Telegram backoff, deletion invalidation, message-not-found handling, and lifecycle cancellation.
- Poker-style internal state and media-style external-state reference applications.

The canonical open implementation work remains in [`../BACKLOG.md`](../BACKLOG.md). This document owns the proposed subsystem contract and its architectural boundaries.
