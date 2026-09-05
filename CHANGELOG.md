# Changelog

> Each release keeps at most 8 outcome records of at most 512 characters.

## 0.42.3: Agent Diagnostics Hotfix

- `Agent Diagnostics`: Identifies `/telegram-status` as a Pi TUI command and routes agents without command access directly to the redacted diagnostic files instead of attempting a shell executable; runtime behavior and STT fallback remain unchanged.
- `Local Architecture Guidance`: Consolidates the repository-local Domain DAG Skill around canonical protocols and removes redundant self-validation configuration and a legacy recipe wrapper; the validator remains available, and this development-only Skill is not included in the npm package.

## 0.42.2: Telegram Comment Membrane

- `Transport-Private HTML Comments`: Removes every assistant-authored `<!-- … -->` block from Telegram previews, active-turn finals, connected companion projections, direct sends, and Guest Mode regardless of Markdown position or owning extension; only recognized top-level comments activate actions, unclosed tails stay hidden, comment-only text plans send nothing, and the Pi terminal transcript remains unchanged.

## 0.42.1: Prompt-Only Button Cells

- `Prompt-Only CML Buttons`: Accepts `{|prompt}` and `{|prompt|selected_style}` as canonical button cells equivalent to prompt-only JSON, so established prompt fallback supplies both visible text and queued input without a separately authored label; empty one-atom cells, prompts, styles, and voice atoms still fail closed.

## 0.42.0: Compact Action Grammar

- `Adaptive Action Grammar`: Extracts the first semantically valid JSON or positional CML payload from noisy `telegram_button` and `telegram_voice` envelopes, tolerates bounded trailing commas and unmatched matrix noise, keeps malformed named JSON on the JSON path, and retains legacy attribute parsing as undocumented compatibility.
- `Voice Action Cells`: Adds compact `{text}`, `{text|lang}`, and `{text|lang|rate}` voice actions while preserving JSON for multiline, named, and escape-heavy payloads; each voice comment remains one independent artifact and matrix-shaped voice payloads fail closed.
- `Thread-Aware Buttons`: Tags prompts created by generated-button callbacks with the same resolved Telegram Thread label as ordinary inbound turns, preserving current local labels, persisted bindings, target routing, queue ordering, and callback selection behavior.
- `Focused Agent Guidance`: Makes generated control surfaces proactively emit useful emoji-led prompt buttons, keeps Telegram action syntax under the bridge owner, and moves specialized delivery, configuration, diagnosis, layout, state, and capability guidance behind conditional references to reduce default context without dropping safety constraints.

## 0.41.1: Focused Operator Status Hotfix

- `Next Turn Feedback`: Replies one Pi-aligned fully bold abort notice to the aborted Telegram turn, falls back to the `/next` command for local work, preserves completed intermediate output, and suppresses pending aborted assistant text so one forced transition no longer produces a contradictory second reply.
- `Status Telemetry`: Keeps the Tokens row compact with input/output totals and moves cache read/write plus the latest cache-hit rate into a dedicated Cache row.
- `Reply Transcription`: Runs replied voice and other media through the inbound handler/provider pipeline and appends provenance-scoped outputs inside the reply context, including Guest Mode, instead of leaving quoted audio as an untranscribed attachment.
- `Information Hierarchy`: Brings access-denial and Threaded Mode chooser headings back under the common fully bold emoji-led sentence/colon contract.

## 0.41.0: Connected Companion Presence

- `Always-On Projection`: Treats authorized Telegram connection as the public-output boundary for local, autonomous, and unclassified Pi work, always delivering completed visible blocks in order instead of exposing an independent proactive-push opt-out.
- `Configuration`: Removes Proactive Push from Telegram Settings and the public config contract, atomically drops retired `assistant.proactivePush` values during normalization, and routes stale pre-upgrade callbacks back to the current Settings surface with an explanatory notice.
- `Work Presence`: Keeps native Telegram typing aligned with unsettled agent and compaction work, pauses it only while extension-owned local UI prompts await the operator, and resumes it after those prompts even when compaction begins after low-level `agent_end`.
- `Compaction Notices`: Preserves observed `Compaction started` and terminal notices across Pi 0.84.4's post-`agent_end` automatic-compaction order, flushing them after the final-answer delivery tail at `agent_settled`.
- `Generated Controls`: Requires semantic emoji-led human-readable labels and defaults non-spatial controls to full-width vertical cells, reserving nested horizontal rows for unmistakably compact peers while retaining reasoned no-marker and genuine spatial-grammar exceptions.
- `Thread Presence`: Aligns the Threaded Mode instance-connected notice with the common information hierarchy by bolding the complete emoji-led sentence while adding nested bold-italic emphasis to the instance name.
- `Status Parity`: Renames the ambiguous Usage row to Tokens and mirrors Pi's compact terminal telemetry in one line, including inline `R`/`W` cache tokens and `CH` for the latest request's cache-hit rate rather than a cumulative-session approximation.
- `Voice Setup`: Links maintained Groq Whisper, Mistral Voxtral, and keyless Edge TTS Skills from the voice guide, documenting their environment requirements and direct `telegram.json` command-template path without a companion extension or local speech model.

## 0.40.0: Pi 0.84.4 Lifecycle Alignment

- `Pi Compatibility`: Requires `@earendil-works/pi-coding-agent`, `pi-agent-core`, and `pi-ai` 0.84.4 or newer, aligning the bridge and its validation runtime with native compaction-failure, mid-run compaction, message-finalization, and UI-prompt lifecycle contracts.
- `Compaction Failure`: Handles `session_compact_failed` immediately by clearing compacting state, stopping observer-owned typing, releasing deferred queue work, abandoning stale activity, and reporting automatic failure or cancellation without duplicating manual `/compact` errors.
- `Compaction Chronology`: Distinguishes terminal assistant output awaiting Telegram delivery from mid-run tool continuation. Post-answer notices remain ordered after the final reply, while tool-result threshold compaction is reported in place before the next assistant response.
- `Local UI Waiting`: Pauses Telegram typing while Pi waits on extension-owned local select, confirm, input, editor, or custom prompts and emits coalesced `ui-prompt-start` / `ui-prompt-end` Activity boundaries before resuming active-turn typing.
- `Inbound Context`: Raises successful inbound handler and built-in text attachment output from 12,000 to 24,000 characters while retaining the 1 MB built-in file admission ceiling and explicit truncation evidence.

## 0.39.5: Auto-Compaction Notice Chronology Hotfix

- `Turn Chronology`: Defers observed automatic-compaction notices while a Telegram turn is still active, preserving the same causal order shown by the terminal: final answer, compaction started, then compaction completed. Abandoned compactions and session shutdown discard deferred notices instead of leaking them into a later turn.

## 0.39.4: Headless Status Bar Hotfix

- `Headless Hosts`: Skips status-bar rendering when a print, RPC, ACP, or other non-interactive host has not initialized its theme, preventing repeated extension errors during lifecycle status refreshes while preserving normal interactive status updates and error propagation.

## 0.39.3: Windows IPC And Outbound Voice Hotfix

- `Windows IPC Replacement`: Replaces an older same-process Named Pipe server before a new session generation listens on the stable endpoint, preventing `EADDRINUSE` during reload while keeping a late stop from invalidating its successor.
- `Windows IPC Fencing`: Applies the ownership commit fence before publishing a Named Pipe, so a stale generation that loses authority cannot expose an endpoint or block its replacement.
- `Windows Voice Commands`: Executes trusted `.cmd` and `.bat` outbound-handler wrappers through escaped `%ComSpec%` adaptation while preserving direct shell-free execution for native executables, bounded process controls, npm command-shim argument isolation, and paths containing spaces.
- `Windows Template Paths`: Preserves backslashes in quoted and unquoted Windows executable and artifact paths without breaking intentional escaped whitespace or quotes, allowing configured TTS handlers to produce and upload OGG/Opus voice replies through direct and follower transport.

## 0.39.2: Deleted Thread Receipt Hotfix

- `Deleted Thread Receipt`: Terminally settles the currently executing durable update when Telegram returns exact HTTP 400 stale/deleted-thread evidence for its `{chatId, threadId}`, including leader-first shared-store invalidation followed by follower settlement. Transient, ambiguous, unrelated, and stale-looking HTTP 5xx failures retain indefinite retry authority; persisted follower records remain restart hints rather than speculative live registrations.

## 0.39.1: Compaction Failure Formatting Hotfix

- `Compaction Failure Formatting`: Preserves the HTML parse mode when a confirmed `/compact` callback reports asynchronous failure, preventing bold standalone failure headings from appearing as literal `<b>…</b>` markup in Telegram.

## 0.39.0: Session-Owned Queue Lifecycle

- `Queue Counters`: Excludes Skip-marked prompts immediately from the shared executable queue count used by the Pi status bar and Telegram main menu while preserving physical queue position, deferred drop semantics, and reversible Keep behavior.
- `Skip Settlement`: Preserves durable receipts while a skipped prompt waits, then settles them atomically when that prompt reaches dispatch before dropping it without inference; settlement failure retains the head instead of creating replay ambiguity.
- `Session-Owned Queue`: Graceful shutdown discards all remaining queue receipts before clearing memory, while startup atomically discards receipts whose former process is proven dead instead of replaying them; replacement and unrelated sessions therefore start without inherited work.
- `Consistent Information Headings`: Standardizes standalone progress, success, empty, busy, unavailable, cancellation, and failure notices as fully bold emoji-led headings, while callback alerts retain equivalent plain text and automatic compaction waits for the preceding final answer before announcing its start.
- `Queue Menu`: Keeps skipped prompts visible in place with their physical ordinal struck through in list and detail views, so deferred removal is legible without renumbering or moving later work.
- `Agent Context`: Routes connected and Telegram-turn guidance across `telegram-bridge`, `generated-control-surface`, and `generative-apps` by activation role, asks the agent to load only missing Skill instructions, and removes Telegram tool context while transport is unavailable.
- `Bot API Reference`: Updates the vendored Telegram Bot API reference and lookup Skill through Bot API 10.3 while retaining the 10.0–10.3 freshness history and validated symbol, anchor, and line indexes.

## 0.38.0: Coherent Voice Reply Policy

- `Voice Reply Policy`: Renames the default user-facing `hidden` mode to `manual` while retaining `hidden` as a read-only configuration and callback compatibility alias. `manual`, `mirror`, and `always` remain the complete policy set: explicit `telegram_voice`, modality mirroring, or automatic voice replacement.
- `Voice Provider Contract`: Removes the redundant `voice.sendTranscript` configuration, `getTelegramVoiceSendTranscript()` public helper, provider-returned `transcriptText`, and voice-caption path. Synthesis providers now return only an OGG/Opus path or `undefined`; text-plus-voice remains an explicit agent composition rather than a parallel automatic policy.

## 0.37.2: Follower Recovery Delivery Hotfix

- `Follower Recovery Delivery`: Holds follower Bot API calls behind a bounded registration wait when heartbeat recovery temporarily clears local authority, then sends once with the restored exact generation. Calls still fail closed if registration is not restored, and acknowledgement ambiguity remains non-retryable.

## 0.37.1: Settings Manager Compatibility Hotfix

- `Menu Compatibility`: Keeps `/start`, model, and queue menu rendering compatible with Pi settings-manager implementations that do not expose `reload()`. Hosts with reload retain explicit refresh behavior; other hosts use the freshly constructed settings snapshot instead of failing with `settingsManager.reload is not a function`.

## 0.37.0: Journal-Owned Telegram Admission

- `Configuration-Only State`: Moves the per-profile polling cursor out of `telegram.json` into atomic durable journal revisions, including cursor-only initial sync, compaction, reconstruction, and recovery. A journal-first one-shot cutover removes legacy config state idempotently, exact bot/profile fences remain enforced, status reads journal authority, and unsafe downgrade now fails closed.

## 0.36.11: At-Most-Once Prompt Dispatch Hotfix

- `At-Most-Once Prompt Dispatch`: Commits each exact durable Telegram receipt synchronously before Pi model admission and blocks dispatch when that commit fails, closing the session/process-replacement replay window that could deliver an already-processed old prompt again; the narrow commit-before-admission crash boundary now favors no duplicate over retry.

## 0.36.10: Transport-Fenced Typing Hotfix

- `Typing Authority Fence`: Starts and continues Telegram typing activity only while the Pi instance has direct ownership or a live follower registration, stopping quietly when authority disappears so classic takeover cannot re-arm a stale loop or flood diagnostics with expected follower-registration errors.

## 0.36.9: Telegram Status And Generated Controls Hotfix

- `Classic Takeover Status`: Keeps a classic-mode client visibly `disconnected` after another Pi instance takes Telegram ownership, preventing stale transport-side activity errors from overriding the authoritative connection state.
- `Generated Button Surfaces`: Makes vertical full-width controls the phone-readable default, earns multi-column rows only for compact labels or emoji-only spatial controls, encourages concise semantic labels, and requires safe 2–6 button controls whenever a Telegram reply asks a bounded blocking confirmation or choice instead of leaving an avoidable prose-only feedback step.

## 0.36.8: Durable Journal Recovery

- `Durable Journal Recovery`: Restricts age cleanup to UUID-prefixed downloads, repairs missing or revisionless snapshots from validated segment evidence, and otherwise quarantines the snapshot plus segments before publishing a fresh journal, keeping `/telegram-connect` operational with informational recovery evidence instead of manual JSON repair.

## 0.36.7: Context-Aware Proactive Controls

- `Proactive Prompt Buttons`: Plans valid top-level `telegram_button` comments before local/autonomous assistant segments enter Rich or HTML proactive delivery, preserving the ordinary callback store and renderer path instead of silently hiding correct controls.
- `Connection-Aware Agent Context`: Successful setup/connect and disconnect commands queue a hidden connection-state note for delivery with the next agent turn without triggering one. Connected system guidance and Telegram Skills now distinguish transport capability from user intent, reserving proactive Telegram controls for Telegram-originated turns or explicit requests.

## 0.36.6: Orphan Journal Guard

- `Orphan Journal Guard`: Rejects a missing journal snapshot when immutable revision segments still exist, preventing later admission from replacing uncertain durable authority with a new revisionless snapshot while preserving snapshot-first compaction and fail-closed recovery.
- `Voice Configuration Guidance`: Guides agents from voice-configuration requests to provider-neutral `telegram.json` command templates, ordered STT fallbacks, OGG/Opus validation, and companion-provider alternatives while preserving `hidden` as the useful default for explicit `telegram_voice` delivery.

## 0.36.5: Separated Tool Errors

- `Separated Tool Errors`: Prefixes Telegram attachment and direct-message Tool failures with one normalized leading newline so Pi renders error evidence on a visually separated line beneath the Tool name without changing the underlying diagnostic text.

## 0.36.4: Async Host Settings Compatibility

- `Async Host Settings`: Normalizes synchronous or asynchronous settings construction plus legacy enabled-model methods or generic `get` / `set` services at the Pi adapter boundary before model-menu reads and scoped-model persistence, improving compatible-host interoperability without changing native Pi behavior or weakening required `agent_settled` semantics.

## 0.36.3: Ordered Prompt Compatibility

- `Prompt Compatibility`: Preserves plain and ordered-block system prompts across Pi-compatible runtimes; Telegram guidance remains a distinct block when the host supplies blocks, while unavailable transport strips only Telegram tool metadata without collapsing unrelated prompt context.

## 0.36.2: Provider-Compatible Controls

- `Provider-Compatible Bind Schema`: Exposes `telegram_bind` through one top-level JSON object schema while retaining runtime enforcement of mutually exclusive install and invocation forms, avoiding providers that reject top-level union schemas before any tool call can run.
- `Reaction Shortcut Naming`: Removes obsolete reaction-action labels from setup guidance now that queue reaction semantics use their current naming.
- `Compact Thinking Picker`: Keeps `off` on a distinct full-width row and groups the six ordered reasoning intensities into two three-button rows, reducing menu height without changing thinking-level values or callbacks.

## 0.36.1: Adaptive Control Surfaces

- `Adaptive Button Literal`: Replaces binary JSON-or-CML parsing with one strict-JSON-first matrix grammar over a shared button AST. Named JSON objects and positional CML cells may coexist in one matrix or row, commas are optional only between completed elements, every compression step preserves semantics, and malformed comments reject atomically without registering partial callbacks.
- `Trusted Release Publication`: Makes tag releases depend on reusable full validation, exact tag/package/lock/changelog identity, npm Trusted Publisher provenance, idempotent existing-version checks, public package and tarball verification, and one workflow-owned GitHub Release path without npm tokens.
- `Consistent Access Denial`: Centralizes unauthorized copy so Guest Mode and private messages render `🚫 Access denied.` with equivalent explicit bold emphasis through HTML-capable surfaces, while callback popups use the same emoji and plain copy without pretending to support rich text.
- `Destructive Skip State`: Changes the active queue Skip selector from yellow to red and records the indicator in the UI registry, making deferred prompt removal visually distinct from Priority, Scoped, and other elevated but non-destructive states.
- `Worker Cancellation Fence`: Makes Generative App workers acknowledge child-process abort handling before parent termination, with a bounded forced fallback for synchronously blocked methods, preventing Linux CI load from orphaning a cancelled process long enough to commit its delayed side effect.
- `Capability App Routing`: Telegram interaction now prefers an already-advertised capability-owned Generative App for repeated controls before synthesizing one-shot prompt buttons, while the bridge remains generic and neither discovers capability-specific apps nor owns their state or identities.
- `Hybrid Surface Routing`: Generated Control Surface and Generative Apps now cross-route over one logical button matrix and shared JSON/CML runtime notation: ephemeral agent composition stays separate from reusable scripts, while one app view may combine deterministic bound methods with ordinary model-mediated prompts and no third button Skill is introduced.

## 0.36.0: Generative Apps

- `Generative App Kernel`: Adds `telegram_bind` for canonical `.mjs` install/replace/invoke with mandatory `init`, strict JSON, bounded output/processes, transactional snapshots, repaired partial-tail recovery, non-symlink root/app/module/source containment, and worker-isolated terminable methods. Lifecycle cancellation stops child processes and fences state commit; failed staging or `init` preserves the installed app.
- `Inference Bypass`: Parses complete `app::method` and strict-JSON argument prompts after one-shot `tgbtn` resolution, invokes the installed app before Pi queue admission, plans returned Markdown/buttons through the current outbound surface, preserves native callbacks and ordinary prompts, marks successful controls, and fails malformed or unsuccessful bound actions without model fallback.
- `Transition Fencing`: Serializes transitions with stable locks outside replaceable app directories, reclaims dead owners, reconciles current state from the last complete snapshot, and carries immutable installation generation plus revision on buttons. Replacement, stale callbacks, and lifecycle loss fail before method effects, state commit, or Telegram delivery.
- `Compact Queue Controls`: Adds strict CML selected styles with atomic validation. Queue detail replaces Delete with independent Priority/Normal and Keep/Skip. Lane transitions append at the destination FIFO tail; Keep/Skip preserves position. Positive and negative reaction categories may coexist; Skip stays reversible, shows only its emoji, and wins at dispatch by dropping the marked head without inference and continuing.
- `Generated Music Player`: Validates a capability-owned Generative App over the public Actor control surface while `pi-telegram` ships only the generic runtime. Live `ffplay` checks confirmed no-model-turn navigation, pause/play, seek, absolute volume, status, and stop with exact terminal Controls and no pending backlog. The app reports Actor availability and uses symmetric seven-button progress and volume scales.
- `Dual Action Views`: Keeps fresh-message delivery as the simple default so prior interfaces and selected buttons remain visible, while `viewMode: "edit"` opts a method into replacing its callback message and keyboard. An explicit edit failure records diagnostics and sends one fresh view; automatic refresh remains a separate lifecycle slice.
- `Direct Initial View`: During an active Telegram turn, `telegram_bind` plans and delivers successful output to the exact target, marks it displayed so the model does not repeat it, and supports `display: false`. Outside turns it returns exact output; delivery failure preserves the app result. Tool success, direct-display, and error text use one leading line break, and failed old-message restyling cannot turn a completed action into failure.
- `Generative Apps Skill`: Adds an operating Skill for compiling repeated interaction into reusable standalone apps or bounded adapters with generated JSON button views. One surface may mix deterministic bound methods with ordinary model prompts; the Skill covers authorship, review, install/replace/invoke, stale actions, and validation while Generated Control Surface retains ephemeral model-mediated interfaces.

## 0.35.2: Independent Surface Dimensions

- `Horizontal Boundary`: Establishes eight controls as the Generated Control Surface phone-width UX maximum regardless of the parser's uncapped row grammar; nine or more controls must regroup, and six-to-eight remains limited to minimal position-bearing labels.
- `Vertical Continuity`: Treats height independently from width so true spatial surfaces may preserve substantially more rows—including an `8×16` field—when coordinates and topology matter, while non-spatial button walls still yield to semantic grouping, progressive disclosure, or pagination.

## 0.35.1: Semantic Ragged Control Layouts

- `Row Composition`: Teaches Generated Control Surface to model Telegram controls as an ordered ragged sequence of independently sized semantic rows rather than filling a rectangular matrix: compact rows hold genuine peers, singleton rows isolate independent actions, and symmetry is admitted only when equal relationships or real spatial topology provide evidence for it.
- `Layout Catalog`: Adds an adaptable shape vocabulary for singleton, binary peer, asymmetric staged, navigation-plus-collection, repeated text-pair, and true rectangular surfaces; agents infer task relationships first and must not force work into a preset shape.
- `Layout Hierarchy`: Limits word-, phrase-, and icon-plus-text controls to two columns and moves additional choices into more semantic rows; denser rows remain reserved for short position-bearing glyphs or codes. Row widths vary intentionally, preserve structural reading order, forbid uniformity padding, and use rectangular grids only when spatial topology carries real meaning.

## 0.35.0: Compact Matrix Literal

- `Compact Wire Format`: Adds portable Compact Matrix Literal alongside JSON and attributes: `{value}` copies label to prompt, `{label|prompt}` separates them, top-level cells remain full-width, nested rows preserve horizontal grouping, and atom boundaries trim automatically.
- `Literal Fidelity`: Preserves non-structural printable Unicode—including brackets, quotes, commas, colons, paths, and spaces—while decoding only `\|`, `\}`, and `\\`; unknown/trailing escapes, empty values, repeated separators, controls, malformed delimiters, empty rows, and deeper nesting fail closed before callback registration.
- `Renderer-Owned Width`: Removes the artificial parser-level row-width cap because Telegram documents none, while bundled Skills keep five columns as the proven default, admit six through eight only for very short position-bearing labels, and direct wider surfaces toward regrouping. A dedicated portable standard owns grammar, JSON-first routing, conformance, and versioning.

## 0.34.1: Compact Stateful Control Surfaces

- `Prompt Compression`: Teaches Generated Control Surface to encode the smallest sufficient action delta—such as a coordinate, symbol, identifier, or short verb—when visible conversation establishes unambiguous state, while retaining stable identity when delivery or routing could separate action from context.
- `Interaction State`: Keeps trivial state conversational, moves large or error-prone state to deterministic task-owned Markdown artifacts, delegates correctness-sensitive rules to small domain-owned transition implementations, and handles repeated clicks as current-state no-ops or selections without assuming transport-level disabled buttons.
- `Five-Wide UX`: Treats five-column matrices as useful for position-bearing interaction only with short distinct labels, falls back to fewer columns when readability degrades, and proactively offers interactive surfaces when they materially reduce user effort rather than merely decorating a reply.

## 0.34.0: Five-Wide Matrix Controls

- `Button Matrix`: Expands compact nested JSON rows from one-to-three to one-to-five buttons for grids, keypads, palettes, games, and other position-bearing controls while preserving full-width top-level rows and existing object, attribute, flat-array, and plural-alias compatibility.
- `Matrix Boundaries`: Keeps empty rows, rows of six or more buttons, malformed payloads, and deeper nesting fail closed before callback registration; published docs and bundled Skills now expose the five-button boundary.
- `Interactive Surfaces`: Teaches Generated Control Surface to use five-wide position-bearing matrices for keypads, palettes, calendars, seat maps, directional controls, small games, and runnable demonstrations while keeping each continuation self-contained instead of inventing hidden application state.

## 0.33.2: Structured Filesystem Surfaces

- `Filesystem Ordering`: Sorts generated directory surfaces by visible directories, hidden directories, visible files, then hidden files, with alphabetical ordering inside each category before fixed ten-entry pagination.
- `Surface Metadata`: Reuses compact status-style key-value rows for filesystem path and range metadata, with bold labels and inline-code values instead of middle-dot section separators or duplicated entry listings.

## 0.33.1: Rendered Command Replies And Visible Compaction

- `Command Rendering`: Restored the `/next` empty-queue emphasis by preserving its HTML source and forwarding `parseMode: "HTML"` through the command reply adapter, so command helpers select the renderer explicitly instead of leaking HTML or Markdown syntax as plain text.
- `Compaction Visibility`: Reports `compacting` ahead of generic active or pending status and sends the same start/completion notices for observed automatic compaction as for manually requested compaction, while retaining queue blocking and deferred dispatch.

## 0.33.0: Matrix Controls And Pinned Filesystem Navigation

- `Button Matrix`: Extended `telegram_button` and its plural alias from flat arrays to JSON matrices: top-level objects remain full-width rows, while nested arrays intentionally group one to three peer controls horizontally; empty, oversized, or deeper rows fail closed without changing existing object, attribute, or flat-array behavior.
- `Filesystem Navigation`: Stabilized Generated Control Surface directory layout: parent traversal is pinned as the first full-width row outside root, available Previous/Next controls share the next compact row, ten-entry pages follow as full-width rows, one JSON-matrix action carries the surface, visible text avoids duplicate plain or monospaced inventories unless user preference overrides it, Refresh is omitted by default, and numbered fallback preserves navigation when buttons are unavailable.
- `Command Rendering`: Replaced the `/next` empty-queue response's leaked HTML tag with native Rich Markdown so Telegram renders emphasis instead of displaying `<b>` literally.

## 0.32.0: Compact Button Arrays And Filesystem Surfaces

- `Button Arrays`: Added JSON-array payloads to the canonical colon-free `telegram_button` action so one hidden comment can declare many ordered button rows; `telegram_buttons` is an exact plural alias, while existing single-object and double-quoted attribute forms remain valid.
- `Filesystem Surface`: Made bare filesystem paths—including `/`—legitimate Generated Control Surface intents. Directory surfaces resolve fresh metadata, paginate large listings, preserve secret boundaries, and may use exact path-only button prompts with compact semantic file/folder labels.

## 0.31.0: State-Derived Generated Control Surfaces

- `Generated Control Surface`: Renamed the optional `control-surface` Skill to `generated-control-surface`, aligned its identity with the architectural primitive, and made Telegram routing evaluate it proactively when controls can materially shorten likely feedback without waiting for an explicit button request; decorative UI still resolves to zero controls.
- `Late-Bound Interface`: Defined generated surfaces as `interface = f(state, capabilities, intent)`: ephemeral renderer projections that expose domain-owned state and agency under constitutional constraints without absorbing parallel state. Telegram remains the first renderer rather than the capability boundary.

## 0.30.1: Priority Button Queue Hotfix

- `Priority Queue`: Assistant-authored button callbacks now enter the sorted priority lane ahead of already queued default prompts, aligning the visible lightning marker with actual dispatch order while preserving callback deduplication and FIFO ordering within each lane.

## 0.30.0: Generated Control Surfaces

- `Generated Control Surface`: Replaced the CLI-bound Button Console with a transport-aware Control Surface Skill that proactively generates truthful contextual controls when they shorten feedback for workflows, stateful systems, navigation, Actor supervision, and decisions while preserving domain ownership, ordinary prompt authority, confirmation boundaries, and stateless regeneration.
- `Action Markup`: Standardized `telegram_button` and `telegram_voice` on one colon-free action marker for both JSON and attribute payloads. Colon-prefixed forms are rejected instead of remaining a redundant compatibility syntax.

## 0.29.0: Skill-First Agent Operation

- `Bundled Skills`: Added discoverable `telegram-bridge` and `button-console` Skills through package metadata and source-checkout resource discovery. Stable turn, delivery, action, Threaded Mode, formatting, handler, and diagnosis guidance now lives in the bridge Skill, while Button Console provides optional evidence-backed CLI navigation.
- `Model Context Contraction`: Removed the redundant `telegram_help` model tool and its repeated guidance implementation. Compact authority-aware prompts route agents to the bundled Skill, while disconnect/recovery now suppresses and restores only the two delivery tools without affecting foreign tools.

## 0.28.0: Durable Inbound And Protocol Reconstruction

- `Owned Polling Request`: Only `getUpdates` gets an automatic budget: Telegram long-poll timeout plus 10 seconds. Poller abort settles requests and API retry waits; broad ordinary, media, and follower budgets were removed.
- `Polling Diagnostics`: Polling now reports exact phases, timestamps, current update, last response, and stop reason. `pollingActive` remains lifecycle evidence rather than a health heuristic.
- `Inbound Command Admission`: Menu commands finish required local mutation before fenced best-effort rendering and command sync. Unsettled `/start` effects and unauthorized capability probes no longer retain polling.
- `Durable Inbound Admission`: Polling journals before offset commit and drains independently. Queue ownership, handoff, single-flight, and fences prevent loss or stale effects. Failures retry forever with a 60-second cap; tri-state proof recovers only proven-dead owners. Revision snapshots survive crashes and downgrade preflight fails closed. Duplicate transitions skip serialization/projection; grouped receipt matching and bounded worker eligibility/retry/failure/diagnostics use indexed or single-pass scans.
- `Local Protocol Identity`: Registration exchanges protocol v1, build, and capabilities; compatible builds may skew. A non-owner refreshes owner mode before connect: enabled registers without takeover, disabled uses classic confirmation. Durable forwarding uses stable binding/source IDs and explicit settlement; only an authenticated exact receipt completes leader authority. Missing, negative, stale, or mismatched ACKs stay durable and replay idempotently across registration replacement.
- `Queue Scheduling`: One disposition mutation serves reactions and queue-menu priority while publishing sorted state once. Removal and dispatch partition in one pass; admission dedupe indexes receipt identity once. Exact receipt replays and repeated no-op reaction snapshots no longer clone or republish unchanged queue state. Removal suppresses, priority promotes, neither restores default, and removal wins when both exist. Suppressed turns retain authority and survive handoff.
- `Async Ownership And Composition`: Long-lived owners serialize in-flight acts and retained reruns. Journal/admission/polling, queue dispatch/handoff, activity, thread/status/cleanup, and agent-message assembly moved from `index.ts` into owning domains. The entrypoint retains visible construction, cross-domain port wiring, and registration without local mutable adapters.
- `Restart-Preserving Quit`: Graceful quit separates durable restart ownership from Telegram tab cleanup: the owner slot remains reclaimable by a reopened same-directory session even when automatic cleanup deletes the tab. Confirmed `/telegram-disconnect` still clears both. Full-suite concurrency is capped at four so process/timer integration evidence is not starved by unrelated test files.

## 0.27.12: Windows Log Serialization Hotfix

- `Windows Log Serialization`: Retried transient guard-publication errors even when a competing path vanished, preserving exactly-once transaction execution and complete concurrent JSONL batches.

## 0.27.11: Follower Connection Notice Hotfix

- `Follower Handoff`: Immediate session handoff verifies the carried target with a chat action instead of repeating the connection notice, while stale-target recovery remains covered.

## 0.27.10: Leader Thread Rebind Hotfix

- `Leader Rebind`: Reclaiming or replacing the leader thread updates live identity after durable commit, keeping agent routing aligned before old-thread cleanup.

## 0.27.9: Symmetric Agent-Turn Metadata Hotfix

- `Agent-Turn Metadata`: Cross-instance prompts use one trusted Telegram prefix with source-thread attribution, preserved through serialized bus forwarding without enabling user impersonation.

## 0.27.8: Bidirectional Thread Routing Hotfix

- `Directional Ownership`: Agent turns bypass ownership only for the already-sent source message while retaining destination-thread routing and exact follower generation checks.

## 0.27.7: Bidirectional Thread Messaging Hotfix

- `Follower-to-Leader Turns`: Follower-originated agent turns retain reply context but bypass source-message ownership, reaching the leader instead of bouncing back to the sender.

## 0.27.6: Autonomous Follow-Up Delivery Hotfix

- `Follow-Up Finals`: Unclassified completed assistant blocks now use Proactive Push with fresh authority, while Telegram-originated finals remain exclusively owned by active-turn settlement.

## 0.27.5: Cross-Instance Agent Turns

- `Live Thread Addressing`: `telegram_message` accepts a live thread name or id and rejects unknown, ambiguous, same, offline, or cross-chat targets before visible mutation.
- `Agent Turn Routing`: Targeted sends route one attributed turn through authenticated generation-fenced IPC while preserving the existing visible message and default `chat_id` behavior.

## 0.27.4: Disconnect Leadership Release Hotfix

- `Leadership Release`: Disconnect persists cleanup intent, attempts fenced thread cleanup, then releases polling and ownership even when Telegram cleanup fails or the epoch changes.
- `Successor Recovery`: Incomplete cleanup remains exact-generation recovery work for the next leader; manual followers still require authenticated live-leader teardown.

## 0.27.3: Follower Cross-Thread Delivery Hotfix

- `Follower Cross-Thread Delivery`: A scoped internal marker permits follower sends only to a different thread in the paired chat, then is stripped before Bot API transport; arbitrary cross-chat access remains denied.

## 0.27.2: Target-Aware Direct Message Guard

- `Direct Message Guard`: `telegram_message` rejects implicit or active-turn targets to prevent duplicate replies, while explicit different targets, local sends, and Proactive Push remain available.

## 0.27.1: Humanized Tool Labels Hotfix

- `Tool Labels`: Tool roots replace underscores with spaces and capitalize words while preserving recognizable uppercase prefixes such as `FF`.

## 0.27.0: Telegram Commentary Delivery

- `Telegram Commentary`: Completed intermediate assistant segments arrive once on the immutable originating target before the final, with ordering, rendering, authority, and no-replay guarantees.
- `Delivery Ordering`: Final delivery waits for admitted activity and commentary inside background delivery without blocking Pi lifecycle completion.

## 0.26.16: Follower Edit Normalization Hotfix

- `Follower Edits`: Bus-routed `editMessageText` treats “message is not modified” as unchanged, matching direct transport and preventing false activity failure.

## 0.26.15: Follower Bus Timeout Hotfix

- `Follower Bus Timeout`: Restored the shared 30-second follower-client default after a one-second fallback caused forwarded updates to time out and replay under load.

## 0.26.14: Reasoning Activity Throttle

- `Reasoning Throttle`: Reasoning edits now wait at least 1.2 seconds and 160 characters after the first frame; terminal flushes and the 24-frame cap remain unchanged.

## 0.26.13: Entrypoint Compression And BotFather Prerequisites

- `Entrypoint Compression`: Moved constants, generation policy, capability answers, and follower/lifecycle assembly into owning domains, leaving `index.ts` as named port wiring.
- `Setup Documentation`: Documented BotFather prerequisites for Guest Mode, private-chat Threaded Mode, and queue-reaction administration.

## 0.26.12: Monospaced Tool Evidence Keys

- `Tool Evidence Typography`: Nested `arguments`, `update`, `result`, and `error` summaries render as lowercase inline code without changing disclosure or delivery behavior.

## 0.26.11: Compact Tool Hierarchy And Ordered Settings Copy

- `Tool Hierarchy`: Evidence children use plain lowercase labels; roots preserve recognizable uppercase prefixes while retaining sentence casing elsewhere.
- `Settings Copy`: Detail descriptions now follow visible control order, including Draft previews `on` before `off (default)`.
- `Windows Gates`: Narrow test budgets cover queued model-menu completion and graceful child shutdown while retaining bounded failure detection.

## 0.26.10: Windows Graceful Disconnect Test Budget

- `Windows CI`: Raised only graceful follower-disconnect test response time from 500 ms to 5 s; production transport and cleanup semantics are unchanged.

## 0.26.9: Windows Filesystem And Timer Resilience

- `Config Persistence`: Atomic config replacement retries bounded transient Windows sharing errors and removes failed temporary files without non-atomic fallback.
- `Ownership Regression`: Test scheduling headroom changed without altering one-second ownership checks or heartbeat behavior.

## 0.26.8: Windows Process-Startup Timing

- `Windows CI`: Raised full-Pi child readiness to 10 seconds and its watchdog to 15 seconds while still rejecting leaked polling and genuine hangs.

## 0.26.7: macOS Follower Reload Identity

- `macOS Identity`: Darwin follower identity derives from parent process start time, preserving a stable durable profile across extension reloads.
- `Follower Handoff`: Registration carries prior runtime and target until acknowledged, preventing refresh races from provisioning duplicate threads.

## 0.26.6: Windows Poll-Wait Boundary Fix

- `Windows CI`: Rechecks the final marker at the polling deadline so boundary-time success passes while genuinely missing evidence still fails.

## 0.26.5: Quieter Scoped Model Labels

- `Model Microcopy`: Scoped model buttons show optional thinking metadata as `provider/model (level)` instead of a middle-dot segment.

## 0.26.4: Quieter Update Omission Labels

- `Tool Microcopy`: Retained tool updates now show omission evidence as `Update N (K earlier omitted)`.

## 0.26.3: One-Tap Tool Arguments

- `Tool Inspection`: Opening a tool root now reveals Arguments immediately; secondary updates and results remain collapsed.

## 0.26.2: Iconless Tool Roots

- `Tool Density`: Removed redundant tool-root emoji while preserving native chevrons, labels, evidence nesting, bounds, redaction, fencing, fallback, and no-replay behavior.

## 0.26.1: Compact Activity Trees

- `Thinking Density`: Removed the standalone thinking header so persistent reasoning uses only its bounded expandable quote.
- `Tool Density`: Each tool is one closed Rich root with nested arguments, retained updates, and result or error evidence.
- `Safety`: Coalescing, bounds, redaction, ordering, fencing, fallback, and ambiguous-send no-replay guarantees remain unchanged.

## 0.26.0: Rich Tool Activity

- `Tool Presentation`: Completed tool batches use native Rich details with separate Arguments, Update, and Result/Error JSON nodes; thinking remains an HTML expandable quote.
- `Activity Safety`: Preserved ordering, coalescing, redaction, bounds, fencing, final ordering, and one safe fallback from Rich rejection to HTML.
- `Defaults`: Fresh installs default Activity to `verbose` and time injection to `interval`; explicit stored settings are unchanged.

## 0.25.7: Multi-Instance Activity Isolation Hotfix

- `Activity Config`: Every process reloads file-backed Activity at agent start and fails closed for that run on refresh failure, preventing stale mode leakage across instances.
- `Activity Labels`: Thinking and tool headers use sentence-case operator labels.

## 0.25.6: Same-Profile Thread Reuse Hotfix

- `Leader Restart`: A replacement with the same stable profile restores the reusable leader binding before cancelling superseded cleanup, avoiding needless thread recreation.

## 0.25.5: Thinking HTML Rendering Hotfix

- `Thinking Presentation`: Provider reasoning renders Markdown emphasis and code as safe Telegram HTML while links remain inert and URL previews stay suppressed.

## 0.25.4: Technical Link Preview Hotfix

- `Activity Evidence`: Thinking and tool sends disable previews and neutralize HTTP(S) auto-linking, preventing technical URLs from creating cards.

## 0.25.3: Thinking Density Header Hotfix

- `Thinking Activity`: Thinking headers show the active Pi thinking level instead of `running` or `done`, and current disclosures skip no-op completion edits.

## 0.25.2: Persistent Thinking Activity Hotfix

- `Activity Modes`: Added `quiet`, `thinking`, `tools`, and `verbose`; thinking became persistent bounded HTML evidence while tools retained their disclosures and previews stayed disabled.

## 0.25.1: Config And Activity Presentation

- `Time Injection Config`: Moved the mode to `assistant.timeInjection`; `time.interval` remains independent and legacy `time.injectionMode` is ignored without migration.
- `Tool Evidence`: Compacted multi-entry JSON evidence while preserving fields, ordering, redaction, truncation, and delivery bounds.

## 0.25.0: Configurable Activity

- `Activity`: Added persisted Activity controls for fenced reasoning drafts and bounded executed-tool evidence, with ordered coalescing and final delivery behind admitted activity. Legacy verbosity is read only when canonical config is absent.
- `Settings Ordering`: Built-in Settings are grouped by operator meaning; extension settings retain explicit order and stable id tie-breaks.

## 0.24.11: Assistant Action Markup Hotfix

- `Action Markup`: Standardized button and voice actions on JSON or double-quoted attributes with optional colons. Removed shorthand, body, paired-comment, unquoted, and single-quoted variants.
- `Composition Root`: Moved bus identity defaults and generated-button edits into owning domains and removed a dormant bus callback.

## 0.24.10: Compact Thread Role Hotfix

- `Status`: Threaded Mode status again appends only `@leader` or `@follower`, avoiding a duplicate visible thread-name row.
- `Validation`: Graceful cleanup accepts committed removal or the safe fenced state retaining exact target plus cleanup intent.

## 0.24.9: Button-Only Heading Hotfix

- `Prompt Buttons`: Automatic button-only parent text now follows dialog grammar as `☑️ **Choose an option:**`.

## 0.24.8: Prompt Button Reliability Hotfix

- `Prompt Buttons`: Button-only replies gain visible fallback text; accepted choices support `primary`, `success`, or `danger` styles while preserving labels and prompt admission.
- `Status`: Threaded identity moved to a dedicated thread-and-role row, keeping execution status unambiguous.

## 0.24.7: Thread Cleanup Hotfix

- `Thread Cleanup`: Graceful teardown persists exact cleanup intent before deletion; successors retry only with stale, dead-process, generation, endpoint, and replacement checks. The setting remains `threads.automaticCleanup`.
- `Button Feedback`: Only the selected prompt button turns green after admission; follower ownership permits the non-fatal markup update.
- `Audit Boundary`: Release audit covers shipped dependencies; host-selected Pi peers remain visible through a separate full-host audit.

## 0.24.6: README Positioning Hotfix

- `README`: Removed duplicate thread-cleanup prose while retaining the canonical lifecycle and configuration explanation.

## 0.24.5: Unclean-Shutdown Recovery Hotfix

- `Shutdown Recovery`: Connect can quarantine only unverifiable disposable ownership artifacts, retry once, and preserve config and diagnostics; blocked recovery gives one restart instruction.
- `Composition Root`: Follower auth and election state moved into one testable follower-control runtime.

## 0.24.4: Context And Thread Lifecycle Hotfix

- `Capability Context`: Telegram tools and prompt metadata now follow effective owner or registered-follower authority and restore the operator’s prior tool subset after reconnect.
- `Graceful Teardown`: Normal Pi quit performs fenced cleanup when enabled; manual disconnect still confirms, session replacement preserves bindings, and hard kills remain recoverable.
- `Temporary Routing`: Unbound temporary threads support forward, replace, restore, and cleanup-only retry without redispatching already delivered work.

## 0.24.3: Queue And Typing Reliability Hotfix

- `Typing Backpressure`: Serialized chat actions and shared 429 suppression prevent direct/follower activity from amplifying Telegram throttling.
- `Queue Lifecycle`: Stale status cleanup is isolated and control settlement is fenced to its originating dispatch generation.
- `Dependency Audit`: Added a fail-closed, expiring exception for two exact upstream shrinkwrap advisories; unknown or drifting findings still fail.

## 0.24.2: Context Compression Hotfix

- `Project Context`: Consolidated release context, reduced open work, and made minimum-Node Ubuntu, macOS, and Windows CI a durable contract.

## 0.24.1: Persistence I/O And Cross-Platform Validation Hotfix

- `Cross-Platform Validation`: Added minimum-Node Ubuntu, macOS, and Windows CI for typecheck, tests, package shape, and one Ubuntu audit.
- `Test Cooling`: Shared bounded process fixtures and timing controls reduced lock-suite cost; 19 unreachable exports were removed after reachability proof.
- `Config Concurrency`: Transactional recursive deltas preserve unrelated writes and monotonic offsets; same-leaf conflicts follow serialized commit order.
- `Diagnostics I/O`: Same-turn JSONL batches preserve order and bounded rotation while isolating failures and respecting owner-only reset authority.
- `State I/O`: Snapshot writes coalesce for 100 ms and skip observationally equivalent replacements while retaining exact-owner fencing.
- `Ownership I/O`: One-second owner checks remain; durable heartbeat writes occur every two seconds with an eight-second stale boundary.
- `Release History`: Consolidated historical chronology while preserving versions, contracts, migrations, limitations, and material outcomes.

## 0.24.0: Canonical Profiles And Extension-Local Ownership

- `Canonical Profiles`: Bot/session identity moved under `profiles.default` and named siblings; unambiguous legacy root identity migrates atomically and conflicts fail closed.
- `Transport Ownership`: Ownership moved from shared `locks.json` to profile-scoped `tmp/telegram/owners.json`. Breaking: legacy ownership is not migrated, so upgrade may require reconnect.

## 0.23.3: Thread-Scoped Settings Hotfix

- `Settings Rehydration`: Expired or reloaded Settings state preserves `message_thread_id`, so callbacks reopen on the exact Threaded Mode target.

## 0.23.2: Voice Policy And Turn Delivery Hotfix

- `Settings Race`: Polling now persists only monotonic offset deltas into the live config snapshot, preventing stale polling state from erasing newer Settings writes.
- `Forward Pairing`: One adjacent owner annotation and forward coalesce in either order while preserving separate owner, source, caption, and media attribution.
- `Voice Policy`: Removed redundant `manual`; absent config is `hidden`, `mirror` follows voice input, and `always` covers every turn. Legacy `manual` resolves to `hidden`.
- `Provider Retry`: Active turns survive retryable low-level agent errors until successful result or settlement, delivering one final outcome to the original target.
- `Status`: TUI error projection is compact; full provider and transport details remain in diagnostics.

## 0.23.1: Context Budget And Runtime Simplification

- `Bus Simplification`: Removed dormant follower recovery helpers and duplicate prune callbacks while retaining accurate heartbeat diagnostics and durable bindings.
- `Reconciliation Safety`: Removed unreachable destructive cleanup paths; explicit deletion paths retain confirmation and epoch fencing.
- `Destination Resolution`: Unified proactive and activity targets on active turn, assigned thread, then paired chat.
- `Agent Context`: Added compact validation, bounded log inspection, search-first large-file rules, and stable-gate validation guidance.

## 0.23.0: Telegram Bot API 10.2 Rich Output And Proactive Projection

- `Follower Recovery`: Visibility probes, exact generations, serialized lifecycle, and bounded promotion preserve recognizable targets without routing to absent or replaced followers.
- `Inbound Attribution`: Adjacent owner comments, forwarded Rich media, attachments, replies, and transcription retain distinct ordered provenance.
- `Proactive Projection`: Default-enabled `assistant.proactivePush` sends deduplicated local/autonomous public blocks through fenced ordered delivery, excluding Telegram turns and technical deltas.
- `Rich Results`: Bot API 10.2 can combine final Markdown, reply/thread metadata, keyboard, and one supported photo, video, or audio artifact with safe fallback and no replay after ambiguity.
- `Rendering And Reference`: Rich normalization preserves structured Markdown; local Bot API 10.2 references and capability docs define the supported surface.
- `Architecture`: Config reads avoid transaction churn; concurrent writes remain guarded and projection, config, and sync adapters moved to owners.
- `Verification`: Deterministic and live multi-instance evidence covered restoration, promotion, attribution, proactive ordering, and composite results.

## 0.22.1: Termux-Compatible Filesystem Transactions

- `Filesystem Transactions`: Replaced hard-link guards with private staged directories and generation files published by atomic rename, preserving exactly-one ownership on Android/Termux.
- `Diagnostics`: JSONL persistence failures remain contained and do not poison later queued records.

## 0.22.0: Concurrency And Runtime Ownership Hardening

- `Architecture`: Moved runtime policy from `index.ts` into flat owners and added structural guards for cycles, entrypoint logic, Pi imports, and leaf drift.
- `Lock Fencing`: Cross-process transactions, collision-resistant epochs, and monotonic generations fence ownership, refresh, release, takeover, transport, and reload handoff.
- `Leader And Followers`: Immediate heartbeat, cleanup-on-start-failure, exact lease checks, atomic promotion, and re-registration prevent split-brain polling and stranded followers.
- `Reconciliation`: Epoch checks guard destructive calls and persistence; recoverable provisioning intents let successors adopt created targets without duplicate creation.
- `Shared State`: Transactional config, immutable profile stamps, revisioned snapshots, serialized logs, and process-birth identity prevent stale writers and PID reuse.
- `Session And Delivery`: Session, target, message, and transport generations fence callbacks, continuations, handles, edits, deletes, and final delivery.
- `Retry Safety`: Inbound admission stays idempotent through offset failure, while method-aware memoization prevents unsafe replay. Live reload and Guest smoke confirmed recovery, attribution, voice, and attachment delivery.

## 0.21.1: Runtime And Session Semantics Hotfix

- `Runtime Semantics`: Telegram targets follow running Pi instances and their active session; the bridge is not a remote terminal or permanent session-file binding.
- `Session Controls`: Telegram can compact but cannot create, resume, fork, browse, or switch sessions until Pi exposes safe public APIs.
- `Context Cost`: Telegram turns use the active session context and do not promise isolation or token cost proportional only to the new mobile message.
- `Prompt Guidance`: Current prompts use a small transient suffix plus on-demand help; older session history may still contain legacy large guidance.
- `Diagnostics Identity`: Pi session JSONL and shared Telegram diagnostics are distinct; connect never launches hidden Pi processes.

## 0.21.0: Activity And Delivery Extension Platform

- `Activity API`: Added ordered, failure-isolated public lifecycle/activity signals with evidence-based identities and fresh Delivery contexts, without exposing Pi contexts or raw provider messages.
- `Activity Lifecycle`: Session generations fence registrations and compaction; adjacent deltas may coalesce, but queue telemetry and broad drop policy are not promised.
- `Delivery API`: Added ownership-gated target delivery with per-target ordering, chunk handles, follower routing, generation invalidation, and partial-failure recovery.
- `Platform Boundary`: Sections own managed callbacks, Activity stays non-interactive, and raw updates remain the low-level escape hatch.
- `Compatibility`: Raised Pi/core/AI floor to `0.80.6`, consumed typed settlement, and added `max` thinking support.
- `Guest Identity`: Private Guest Mode prefers strong remote-peer evidence and keeps reply-source attribution separate.
- `Verification`: Public-boundary and full-runtime tests cover roles, targets, authorization, stale generations, ordering, recovery, cleanup, and non-blocking lifecycle hooks.

## 0.20.6: Guest Attribution And Voice Action Hotfix

- `Voice Syntax`: Added paired voice comments alongside inline forms while preserving visible prose; generated audio still uses the established delivery path.
- `Guest Attribution`: Private Guest Mode identifies the remote peer rather than the paired owner, with username, display-name, and numeric fallbacks.

## 0.20.5: Guest Media And Runtime Recovery Hotfix

- `Setup Persistence`: Validated bot identity enters live config before atomic persistence and rolls back on failure, preventing unsaved-success states.
- `Guest Media`: Guest answers support one bounded cached media result with caption, staging cleanup, and no replay after ambiguous one-shot delivery.
- `Guest Voice`: Explicit or policy-selected TTS uses the provider chain and returns one cached voice result with visible text as caption.
- `Leader Endpoint Recovery`: A live leader can recreate an externally unlinked Unix socket without changing epoch, polling, or bindings; forced takeover stays denied.
- `Profile Diagnostics`: Profile logs use unambiguous current and `_prev` paths; profile names are lowercase alphanumeric.
- `Compaction Presence`: Native typing represents compaction across assigned and aggregate targets; Pi remains the terminal status owner.

## 0.20.4: Thread State Ownership Hotfix

- `State Ownership`: Only the active transport owner writes profile-shared state; followers read until promotion and status writes refresh disk bindings first.
- `Follower Recovery`: Re-registration carries exact target, slot, and name so missing local state can recover the live thread without duplicate provisioning.
- `Thread Identity`: One target-aware resolver aligns prompt tags and terminal status, preferring live leader/follower metadata over stale snapshots.
- `Live Evidence`: Multi-process Linux and deterministic regressions confirmed unique slots, denied stale writers, promotion authority, and identity convergence.

## 0.20.3: Persistent Threads And Activity

- `Follower Sessions`: Session replacement snapshots follower identity and automatically re-registers through the leader, preserving exact target, slot, and thread name.
- `Thread Identity`: Stable follower identity and refreshed recovery timestamps prevent reload overlap from rotating names or creating duplicate tabs.
- `Native Activity`: Every connected instance shows native typing for Telegram, local, and autonomous work on its assigned target and aggregate `All`.
- `Live Evidence`: Leader and follower reload/new paths preserved threads; test harness timing changed only to avoid loaded-suite false failures.

## 0.20.2: Live Thread Reality

- `Profile Activation`: Validate and start a named profile before committing the switch; cancellation, bad token, missing profile, or startup failure leaves healthy transport unchanged.
- `Profile Diagnostics`: Status and help show exact selected-profile state and log paths.
- `Bus Composition`: Profile IPC, follower lifecycle, leader provisioning, and reconciliation moved into cohesive owners with import guards.
- `Slot Ring`: Allocation now follows a true `A…Z → A` cursor from fresh reality without unrelated high-slot drift.
- `Reality Reconciliation`: After bounded grace, live roster and persisted bindings converge without deleting tabs or overriding pending and reserved guards.
- `Validation`: Live reload and deterministic recovery evidence passed; strict unused-local and unused-parameter checks joined typecheck.

## 0.20.1: Profile IPC Isolation Hotfix

- `Runtime Isolation`: Unix sockets and Windows pipes are profile-scoped while default-profile endpoints remain compatible.
- `Profile Switching`: Servers, clients, diagnostics, and follower registration resolve endpoints from the active profile at operation time.

## 0.20.0: Pi-Compatible Multi-Profile Runtime

- `Profiles`: Added named bot/session profiles while preserving top-level default identity and paths; activation is session-local and shared bridge settings remain global.
- `Runtime Isolation`: Locks, owner keys, logs, previous logs, and Threaded Mode state are profile-scoped.
- `Pi Compatibility`: Centralized agent-dir resolution with `PI_CODING_AGENT_DIR`; queued prompts again enter Pi as normal scheduled turns.
- `Prompt Context`: Telegram surface, reply, forward, and attachment provenance use distinct compact metadata layers.
- `Threaded Mode`: Reload, reconnect, disconnect, and registration races now preserve explicit follower lifecycle without duplicate tabs.
- `Reliability`: Hardened Windows lock writes, virtual prompt-template filtering, and non-idempotent topic creation.
- `Validation`: Local and live evidence covered profile isolation, OMP-style dispatch, follower churn, status, and slot wraparound.

## 0.19.2: Draft And Rendering Isolation Hotfix

- `Config`: Assistant rendering and draft previews moved under `assistant`, with legacy keys read and cleaned for compatibility.
- `Preview`: Disabled previews create no state; enabled previews use the selected Rich or HTML renderer consistently.
- `Rendering`: Thread-anchored final replies now respect explicit Rich versus HTML selection instead of forcing HTML.

## 0.19.1: Settings Layer Hotfix

- `Settings`: Split Draft previews from Assistant rendering so operators control streaming visibility independently from final format.
- `Rendering`: Native Rich Markdown is the default; persisted HTML remains the explicit compatibility path and legacy preview config still loads.

## 0.19.0: Telegram Companion Hub

- `Rendering Boundary`: Model and Guest answers use Rich Markdown; bridge-owned menus, status, controls, diagnostics, and technical UI retain HTML or plain rendering.
- `Draft Preview`: Added opt-in Rich drafts without changing final native rendering.
- `Product Entrypoint`: Reframed README around the companion runtime, operating model, feature catalogue, safety boundary, extension platform, and docs.
- `Guest Mode`: Unauthorized guest queries now include the standard denied-action marker.

## 0.18.6: Threaded Mode parity hotfix

- `Follower Ownership`: Target evidence routes edits, reactions, callbacks, queue controls, and menu cleanup to the correct follower even when thread identity is absent.
- `Follower Parity`: Followers can register commands and publish bounded thread plus aggregate activity with accurate active/compacting precedence.
- `Promotion And Reload`: Snapshotted bindings and exact profile conversion preserve visible threads across election and replacement.
- `Restoration`: Reused follower targets require a visibility probe; only explicit stale evidence authorizes recreation.
- `Unbound Routing`: One current-roster chooser can replace or restore any live instance target.
- `Evidence`: Capability matrix, deterministic tests, and live Linux smoke established leader/follower parity.

## 0.18.5: Windows Threaded Mode stabilization hotfix

- `Bus Transport`: Added transport-owned endpoint, retry, timeout, reachability, event, and handler-ACK policy for Unix sockets and Windows pipes.
- `Windows IPC`: Deterministic follower endpoints and a longer prune window reduce false disconnects; debug status identifies pipes versus sockets.
- `Capability Switching`: Hot downgrade preserves the current leader as classic poller and disconnects followers only after confirmed capability loss.
- `Diagnostics`: Log reset preserves the prior session as `logs.previous.jsonl`.
- `Previews`: Native previews suppress syntax-only prefixes and removed dormant throttle/clear branches.
- `Validation`: Native Windows smoke covered classic ownership, hot upgrade, follower delivery, and hot downgrade.

## 0.18.4: Windows Threaded Mode hotfix

- `Windows IPC`: Follower registration retries transient local endpoint startup failures.
- `Queue`: A session-bound watchdog retries dispatch while Telegram work remains queued.

## 0.18.3: Threaded Mode live hotfix

- `Dispatch`: Inbound prompts request immediate and deferred dispatch so readiness gaps do not require reload.
- `Thread Lifecycle`: Reconciliation avoids cosmetic renames and refuses to auto-claim unknown threads while another live target exists.
- `Follower API`: Safe identity reads and chat-level activity are allowed while thread-scoped writes remain restricted.
- `Status And Menus`: Leader names persist in status; one-page model pagination and empty scope tabs stay hidden.

## 0.18.2: Setup pairing start hotfix

- `Setup`: Live config updates after token persistence and before polling, so first setup can receive `/start` without restarting Pi.

## 0.18.1: Windows setup transport hotfix

- `Setup Transport`: Token validation uses normal fallback-aware transport and reports retryable connectivity failures as setup notifications.
- `Terminology`: Docs consistently reserve Threaded Mode for the runtime mode, threads for the client surface, and BotFather for bot configuration.

## 0.18.0: Threaded Mode

- `Mode`: Added private-chat threads as the automatic multi-instance mode; one leader owns polling and Bot API transport, followers join explicitly, and Telegram never spawns Pi.
- `Capability And Recovery`: Evidence-driven hot switching and lifecycle recovery preserve bindings across reload, reconnect, election, disconnect, and stale cleanup.
- `Thread State`: Explicit owners, slots, names, reservations, reroute/restore, notices, and proof-before-delete reconciliation avoid duplicate or uncertain cleanup.
- `Target Runtime`: `{ chatId, threadId? }` now scopes routing, queues, models, replies, previews, media, controls, and follower API calls.
- `Delivery`: Native activity, first-block reply anchoring, asynchronous side effects, and proactive follower delivery preserve responsiveness and target identity.
- `Transport Security`: Redacted network fallback, leader secrets, private endpoints, owner checks, target allowlists, Unix sockets, and Windows pipes secure local IPC. Windows live smoke remained pending.
- `Diagnostics`: Status, state, and logs expose role, roster, capability, reconciliation, and health without becoming routing authority.

## 0.17.5: Screenshot Refresh

- `Docs`: Refreshed the package screenshot.

## 0.17.4: Native Rich Markdown Splitter Hotfix

- `Rich Markdown`: Oversized code, display-math, and wrapped inline blocks are rewrapped at transport splits so each chunk stays structurally valid.

## 0.17.3: Native Draft Preview Hotfix

- `Rich Markdown`: Multiline `$$` math normalizes to supported math fences while literal delimiters inside code remain untouched.
- `Preview`: Removed plain fallback bubbles and emits only structurally closed native Markdown prefixes; invalid intermediate frames wait for a safe boundary.
- `Validation`: Live smoke covered drafts and finals with lists, code, links, display math, and buttons.

## 0.17.2: Indented List Rich Markdown Hotfix

- `Rich Markdown`: Indented list markers are neutralized consistently across drafts, edits, and finals while top-level lists remain native.
- `Validation`: Regression fixtures preserve formatting and payload tails through splitting and send delivery.

## 0.17.1: Rich Markdown Parser Hotfix

- `Rich Markdown`: Normalized fragile blockquotes and dollar-prefixed atoms, preferred Rich reply plaintext, and kept copyability guidance generic.

## 0.17.0: Native Rich Markdown Delivery

- `Rich Markdown`: Assistant and Guest answers use Telegram Rich Message APIs for finals, drafts, edits, and guest content instead of legacy HTML conversion.
- `Preview UX`: Rich Draft lifecycle uses serialized flushes without default debounce, rendering dependency, or post-final clearing.
- `UI Boundary`: Bridge-owned UI remains HTML/plain, while companion sections may choose Markdown, HTML, or plain text.
- `Limits`: Typed Rich helpers disable entity detection and split at character/block limits, keeping replies on the first and keyboards on the last chunk.
- `Docs And Tests`: Documented and covered native delivery, guest replies, preview lifecycle, splitting, formulas, and UI compatibility.

## 0.16.6: Telegram Review Hardening Hotfix

- `Guest Pairing`: Guest updates are rejected until an owner pairs through DM.
- `Lifecycle`: Shutdown ordering, unrefed compaction fallback, retained poll abort state, and contained typing cleanup prevent leaked or reordered teardown.
- `Reply And Button Safety`: Reply dedupe is chat-scoped; button actions are one-shot and callback byte limits fail locally.
- `Diagnostics`: Callback acknowledgement failures are non-fatal and visible in runtime evidence.
- `Verification`: Focused boundary tests cover shutdown, Settings, Markdown, and outbound retry behavior.

## 0.16.5: Context-Aware Prompt Guidance Hotfix

- `Prompt Guidance`: Unconfigured sessions get no bridge suffix, local turns get direct-delivery guidance, and Telegram turns retain the full mobile contract.
- `Product Boundary`: The bridge is a companion for a live Pi session, not a terminal or process launcher; session replacement awaits a supported Pi API.

## 0.16.4: Follow-Up And Runtime Mode Hotfix

- `Runtime`: `print` and `json` modes remain passive when detectable; `tui`, `rpc`, and older Pi runtimes preserve polling behavior.
- `Queue`: Telegram prompts and unknown callbacks use explicit follow-up delivery semantics during busy Pi runs.

## 0.16.3: Ownership And Shutdown Hotfix

- `Ownership`: Only the current connect owner can proactively push non-Telegram finals; accepted Telegram turns still finish session-locally after ownership moves.
- `Shutdown`: Retry waits are abort-aware, non-critical timers are unrefed, and composed lifecycle cleanup clears direct-delivery context.
- `Status`: A configured token without username reports bot identity as `unknown`, not `not configured`.
- `Verification`: Process, lock, queue, ownership, abort, shutdown, and headless regressions protect the boundary.

## 0.16.2: Screenshot Refresh Hotfix

- `Docs`: Refreshed the package screenshot without runtime changes.

## 0.16.1: Disconnected Queue Status Hotfix

- `Status`: Local queue count remains visible after polling ownership moves to another Pi instance.

## 0.16.0: Telegram Extension Commands

- `Command API`: Added public `registerTelegramCommand()` with reserved built-ins, safe names, duplicate rejection, optional menu visibility, required emoji for visible commands, isolated handlers, and defined routing precedence.

## 0.15.1: Typing Keepalive Cadence

- `Typing Status`: Set native typing keepalive to 2.5 seconds with a 250 ms idle-drain cap.

## 0.15.0: Companion Status Lines

- `Status API`: Added synchronous, model-aware, failure-isolated `registerTelegramStatusLineProvider()` rows for companion extensions without transport ownership.
- `Docs`: Documented the provider through an abstract example and listed the concrete quota companion separately.

## 0.14.0: Direct Telegram Delivery, Queue Semantics, And Section Diagnostics

- `Prompt Guidance`: Agents use visible Markdown plus top-level button comments, avoiding standalone actions and comments inside code or nested structures.
- `Command Templates`: Synced the local portable template standard with risk labels, recipe context, short-flag detection, and trusted-executable guidance.
- `Tools`: `telegram_attach` and `telegram_message` support explicit local delivery with ownership checks; active-turn replies remain on normal final delivery.
- `Status`: Compaction reads as active; typing cleanup gives the last in-flight action a bounded drain before final delivery.
- `Queue`: Queue and replies remain per Pi instance when transport ownership moves; abort-history applies only to Telegram-owned runs.
- `Sections`: Section failures are source-scoped, recover independently, and keep Settings-level navigation.

## 0.13.2: Config Recovery And Inbound Output Bounds Hotfix

- `Config`: Invalid config is renamed to a recovery file on startup, safe defaults load, and diagnostics remain available for setup repair.
- `Inbound Bounds`: Handler, transcription, and built-in text outputs are bounded before entering prompts.
- `Diagnostics Bounds`: Event details and handler stdout/stderr are truncated with explicit evidence.

## 0.13.1: Rendering, Typing, And Continue Queue Hotfix

- `Rendering`: Markdown emphasis spanning soft line breaks now renders as Telegram HTML instead of raw markers.
- `Typing`: Preview and provider transport failures no longer break active-turn typing keepalive.
- `Continue Queue`: `/continue` enters the control lane, clears abort history, and runs before waiting prompt work.

## 0.13.0: Command Template Standard, Voice Hardening, And Domain Cleanup

- `Command Templates`: Breaking 0.x update adopted portable parallel, condition, duration, retry, fallback, flag, and failure semantics, replacing local `mode`, `critical`, and `pipe` shapes.
- `Voice Providers`: Monotonic generated ids, registry probing, and exact-instance disposers preserve provider lifecycle and re-registration.
- `Outbound Actions`: Voice markup, button planning, and delivery moved into acyclic owners while public behavior remained compatible.
- `Menus And Diagnostics`: Direct domain tests cover menu/setup contracts and status category summaries.
- `Architecture And Security`: Restored acyclic imports, centralized Pi SDK access, clarified Bot API naming, and enforced private temp and ownership modes.
- `Public Guidance`: Stable membranes now own extension examples and callback/navigation contracts; internal `/lib` imports were removed from guidance.
- `Verification`: Long-session queue, model-switch, markup, split-text, provider, menu, setup, and migration risks received focused coverage.

## 0.12.0: Public API Membranes, Telegram UX Safety, And Extension Interop

- `Breaking API`: Replaced published `./lib/*.ts` paths with stable sections, updates, inbound, outbound, voice, and keyboard membranes.
- `Interop`: Named the low-level update registry, defined stable versus id-less identities, rejected duplicate section ids, and enforced callback byte limits.
- `Architecture`: Separated updates from polling and Pi bindings from runtime domains; public API and ownership docs map the boundaries.
- `Compaction`: Manual compaction confirms first and uses native typing with settlement, timeout, and shutdown cleanup.
- `UI Standard`: Standardized toggle, tab, option, navigation, and confirmation language.
- `Config Defaults`: Hidden Time Injection removes its key, matching absent-key Voice defaults.

## 0.11.2: Queue Continuation, Compaction Safety, And Settings Polish

- `Settings`: Disabled time injection became absent-key `hidden`; legacy values remain readable and details show current state.
- `Continue Queue`: `/continue` adds one priority prompt without folding waiting prompts into hidden history.
- `Compaction Safety`: Dispatch pauses across native compaction hooks and resumes after settlement.
- `Command Templates`: Added typed/index placeholders, repeat fanout, failure/recover, unbounded default timeout, and trusted-command warnings.
- `Public Boundary`: Removed root API re-exports so `index.ts` remains default-only composition.
- `Documentation`: Split oversized architecture material and aligned operator labels and reactions.

## 0.11.1: Time Context And Settings Polish

- `Time Context`: Added optional `off`, `always`, or per-chat `interval` time context after attachments, outputs, and voice metadata.
- `Settings UI`: Proactive push, time, and voice controls gained aligned emoji labels and state text.

## 0.11.0: Voice Provider Platform

- `Provider APIs`: Added provider-owned STT/TTS registration and explicit precedence behind configured and programmatic handlers.
- `Voice Policy`: Added bridge-owned `manual`, `mirror`, and `always` reply policy with compact prompt context and explicit-action priority.
- `Settings Interop`: Built-in controls and a narrow live-config port let providers reflect policy without owning it.
- `Native Delivery`: OGG/Opus voice uses native delivery and falls back to markup-stripped text when safe.
- `Handler Matrix`: Programmatic inbound handlers joined configured commands and provider fallback in one precedence model.
- `Lifecycle`: Registries own independent globals and cleanup; session shutdown cannot erase unrelated extension registrations.
- `Docs And Tests`: Added native-format, policy, provider, fallback, prompt, and lifecycle contracts.

## 0.10.8: Compact Typing Timing Hotfix

- `Compaction`: `/compact` starts typing only after its start notice and stops on completion or failure.

## 0.10.7: Stale Context Hardening Hotfix

- `Session Reloads`: Context-sensitive paths ignore only recognized stale-context failures; unrelated errors remain visible.
- `Runtime Status`: Status failures propagate to existing safety wrappers for structured diagnostics.
- `Release`: Tag-triggered GitHub Actions verifies version parity and publishes the matching changelog section.

## 0.10.6: Native Typing Keepalive Hotfix

- `Typing`: Native typing refresh moved from 4 seconds to 2.5 seconds for better visibility during long work.
- `Queue Menu`: Empty queue refresh rotates through additional compact status phrases.

## 0.10.5: Queue Continuity And Input Resilience Hotfix

- `Compaction`: Completion and failure schedule deferred queue dispatch after Pi state settles.
- `Text Groups`: Long-text coalescing keeps a conservative start threshold but tolerates wider message-id drift across likely Telegram chunks.
- `Runtime Status`: Typing and dispatch status are best-effort with structured stale-context diagnostics.

## 0.10.4: Polling Status Resilience Hotfix

- `Polling`: Stale-context status updates cannot crash polling; failures record `phase: status-update` without changing API or config behavior.

## 0.10.3: Dependency Audit Hotfix

- `Dependencies`: Refreshed transitive development dependencies to clear current protobuf audit findings without runtime API changes.

## 0.10.2: Delete Message Port Hotfix

- `Section API`: Added `ctx.deleteMessage()` for callback-triggered cleanup, backed by Bot API deletion and error recording.
- `Docs And Demo`: Interactive confirmation examples now delete their dialog and open a follow-up result.

## 0.10.1: Navigation Abstraction Hotfix

- `ctx.open()`: New chat messages no longer receive an automatic Back row; `ctx.edit()` retains context-aware menu navigation.
- `Platform Docs`: Added interactive out-of-menu confirmation and approval patterns.

## 0.10.0: Extension Sections Platform

- `Sections API`: Added tokenized extension views and narrow callback contexts for answer, edit, open, prompt enqueue, callback creation, and diagnostics.
- `Menu Integration`: Extension rows and Settings compose before built-ins; stale tokens fail safely and unclaimed callbacks retain fallback behavior.
- `Navigation`: Context-correct Main menu and Back rows are deduplicated automatically.
- `Companion Demo`: Published a standalone example extension with Explorer, prompt enqueueing, and Settings state.
- `Operator UI`: Standardized model labels and removed redundant terminal `/telegram-settings` while retaining Telegram `/settings`.
- `Verification`: Registry, ordering, parsing, fallback, stale token, open/edit, and navigation contracts gained direct coverage.

## 0.9.9: Guest Mode HTML Rendering

- `Guest Rendering`: Guest replies use the normal Markdown-to-HTML renderer, matching DM formatting.
- `Reply Domain`: Guest Markdown delivery moved behind a replies-domain sender.
- `Guest API`: Answer titles are fixed and keyboards are omitted because inline callback routing lacks chat/message identity.

## 0.9.8: Guest Mode Context

- `Guest Context`: Prompt prefixes identify sender and source group, replies preserve author attribution, and media uses the normal attachment/output turn builder.
- `Prompt Guidance`: Added compact explanation of Guest Mode source and reply metadata.

## 0.9.7: Bot API 10.0 Alignment

- `Runtime Baseline`: Migrated Pi peers to `@earendil-works/*` and declared Node `>=22.0.0`.
- `Guest Mode`: Added authorized `guest_message` routing and Bot API 10.0 `answerGuestQuery` delivery without joining the source chat.
- `Draft API`: Drafts accept empty text, entities, parse mode, and optional thread id.
- `Presence And Tests`: Guest sentinel targets suppress typing; focused coverage protects guest and draft boundaries.

## 0.9.6: Runtime Adapter Positioning

- `Package`: Repositioned the project as a Telegram runtime adapter for Pi.
- `Telegram API`: Added configurable API base and documented native environment-proxy support; SOCKS5 remains outside zero-dependency core.
- `Dependencies`: Refreshed transitive packages to restore a clean audit.
- `README And Context`: Rebuilt the install-to-operation entrypoint and made its runtime-adapter, `/start`, and env-config rhythm durable.

## 0.9.5: Telegram Delivery Resilience Hotfix

- `Preview And Final Delivery`: Telegram transport failures are recorded and contained so cleanup, attachments, and queue dispatch continue.
- `Diagnostics`: Preview and final errors carry compact phase metadata.
- `Sections Draft`: Reserved the future Sections namespace and documented the shared Telegram-shell direction without exposing an API.
- `Docs`: Normalized Markdown shape and tightened proactive-push copy.

## 0.9.4: Temp Dir And Command Template Hotfix

- `Temp Dir`: API temporary files honor `PI_CODING_AGENT_DIR` with the standard agent-dir fallback.
- `Command Templates`: Documented portable mode, delay, repeat, placeholder, padding, and limited arithmetic semantics.
- `Queue Menu`: Refresh remains in a stable position and empty states rotate through compact headings.

## 0.9.3: External Handlers Rename

- `External Handlers`: Renamed the domain and docs from `external-update-handlers` to `external-handlers`.
- `Breaking`: Removed old module paths and aliases; consumers must use the new path and `TelegramExternalHandler*` names.

## 0.9.2: External Update Interceptors

- `Update Interceptors`: Added a validated versioned global registry for same-process extensions to observe or consume updates before default routing without another poller.
- `Queue Menu`: Non-empty queue lists retain a Refresh row below items.
- `Security`: Refreshed the lockfile to clear a transitive audit advisory.

## 0.9.1: Model Detail Hotfix

- `Model Menu`: Detail activation preserves scoped thinking and reapplies it even when selecting the already active model.
- `Proactive Push`: Removed an unused reply-target store; proactive local results send without reply anchoring.
- `Queue Reactions`: Added fire priority and wastebasket removal gestures.

## 0.9.0: Hidden Settings And Proactive Push

- `Settings`: Added hidden Telegram Settings and terminal controls for proactive push.
- `Proactive Push`: Optional successful local finals reach the paired chat only under current ownership; local prompt text is never mirrored.
- `Queue UI`: Refined empty/non-empty icons, item position, priority tabs, reaction markers, and active status after queue mutation.
- `Model Menu`: Model details provide activation and scoped/all membership controls.
- `Status And Guidance`: Compaction appears in the menu and prompt guidance targets narrow mobile layouts.

## 0.8.2: Lock-Safe Delivery

- `Lock Safety`: Active turns recheck singleton ownership before preview and final delivery, silencing displaced owners.
- `Inbound Handlers`: First composition steps receive the full configured timeout before elapsed accounting.
- `Menu UI`: Model and Thinking headings gained matching icons.

## 0.8.1: Outbound Voice Translation Hotfix

- `Outbound Voice`: The first voice pipeline step receives original hidden text on stdin, enabling translation before TTS.
- `Queue Menu`: Raw bounded prompt previews, clearer waiting icons, explicit deletion confirmation, and preserved priority emoji improve queue control.
- `Configuration Docs`: Advanced config remains agent-assisted rather than gaining premature UI.
- `Handler Docs`: Voice pipelines and the portable command-template standard now describe retry, critical failure, and default timeouts accurately.
- `Lock Docs`: Synchronized the extension-neutral lock standard.

## 0.8.0: Handler Bus

- `Inbound Bus`: Added provider-neutral text/media transformations with selector matching, stdin/placeholders, ordered fallback, and output replacement.
- `Text Attachments`: Built-in fail-open UTF-8 reading makes ordinary text files available without custom handlers.
- `Domain Names`: Renamed inbound and outbound attachment modules to match their unified responsibilities.
- `Compatibility`: Deprecated `attachmentHandlers` remains appended after canonical `inboundHandlers`.
- `Outbound Text`: Added final text transformations, including preview finalization, without changing button callback prompts.
- `Docs`: Consolidated inbound handler documentation and added translation and composed voice examples.

## 0.7.2: Split Text Coalescing Hotfix

- `Text Coalescing`: Likely near-limit Telegram chunks from one sender are short-debounced into one prompt; commands, media, captions, bots, and normal follow-ups bypass it.
- `Callback Namespaces`: Current navigation emits `menu:` while legacy `status:` remains reserved but no longer generated.
- `Runtime Tests`: Removed timing races in media-group and reaction-priority coverage.

## 0.7.1: Layered Callback Interop

- `Callback Interop`: Unowned callback namespaces fall back to Pi as `[callback] <data>` after bridge handlers decline them, enabling layered extensions without another poller.
- `Prompt Templates`: Template aliases remain in `/start` but no longer clutter Telegram’s global command menu.

## 0.7.0: Unified App Menu & Command Template Hardening

- `Commands`: Reduced visible commands while keeping compatibility shortcuts; start, help, and status share one operator surface and continue enters priority control flow.
- `Queue Controls`: Added queue inspection, item actions, reactions, refresh, and direct entry with control-safe ordering.
- `Prompt Templates`: Discovered conflict-safe aliases and expanded template files plus arguments before queueing.
- `Menu Domains`: Split queue, model, thinking, and status views into owners with consistent navigation and paging.
- `Runtime Safety`: Atomic config, first-block reply anchoring, typing diagnostics, and typed preview markup harden delivery.
- `Command Templates`: Standardized 30-second timeout and fail-open composition with optional critical abort.
- `Verification`: Focused coverage protects menus, queue mutation, continuation, templates, replies, composition, and preview markup.

## 0.6.3: Outbound Action Syntax & Prompt Guidance

- `Action Syntax`: Added label-only buttons and explicit one-line voice/button attributes; hidden bodies remain attached inside parser recovery windows.
- `Prompt Guidance`: Reorganized Telegram guidance around inbound context, visible output, and native actions with less duplication.
- `Architecture`: Named major runtime collaborators before entrypoint registration.
- `Config`: Missing config now uses an explicit existence check instead of read exceptions as normal flow.

## 0.6.2: Reload-Stale Queue Dispatch Hotfix

- `Queue Dispatch`: Deferred dispatch is session-bound and cancelled on shutdown.
- `Timer Safety`: Typing, lock watchers, and media-group timers no longer retain stale live contexts; diagnostics and controller state own late work.

## 0.6.1: Outbound Action & Command Timeout Hardening

- `Command Runtime`: Timed-out child commands escalate from `SIGTERM` to `SIGKILL`.
- `Outbound Buttons`: Button bodies are optional when prompt and label are equal.
- `Comment Parsing`: Native actions after valid closing code fences are recognized without executing code examples.
- `Template Docs`: Documented the strict `timeout` and string-array `args` contract; legacy shapes are not presented as supported.

## 0.6.0: Command Templates & Assistant-Authored Outbound Actions

- `Outbound Actions`: Hidden voice and button comments create native audio or queued prompts while visible Markdown remains the answer.
- `Outbound Semantics`: One owner plans voice, buttons, artifacts, callback prompts, reply metadata, and post-result delivery.
- `Command Templates`: Added a shell-free portable contract for strings/sequences, declarations, defaults, timeout, piping, and artifact output.
- `Domain Boundaries`: Split inbound preprocessing, outbound actions, and reusable template mechanics into mirrored owners.
- `Docs`: Replaced host-local commands with portable placeholders and consolidated template guidance.

## 0.5.2: Telegram Reply Context

- `Reply Context`: Normal prompts include bounded replied text or caption, while slash-command parsing still uses only the new message.
- `Docs And Tests`: Documented and covered truncation, queued edits, command safety, and reply forwarding.

## 0.5.1: Stop Queue Reset Hotfix

- `Queue Safety`: `/stop` clears waiting prompt/control work, model-switch and abort-history state, then aborts the active run when possible.
- `Docs And Tests`: Updated the high-risk stop and queue contract.

## 0.5.0: Command Templates, Domain Boundaries & Queue UX

- `Queue UX`: Immediate controls, settled-idle retry, specific busy labels, and local reaction priority keep text and attachment turns ordered.
- `Attachment Handlers`: Portable templates, defaults, and fallback chains support configured preprocessing without private tool registries.
- `Domain Boundaries`: Registration responsibilities moved to attachment, command, lifecycle, and prompt owners.
- `telegram_attach`: Outbound staging, limits, failure events, and tool results moved into the attachment owner.
- `Docs And Validation`: User docs, architecture, focused coverage, and repository contents aligned with the new domains.

## 0.4.0: Singleton Locks & Attachment Handlers

- `Locks`: Added shared singleton ownership with stale replacement, confirmed takeover, explicit disconnect, session suspension, and same-directory resume, separate from bot config.
- `Attachment Handlers`: Added MIME/type preprocessing with safe placeholders, compact attachment/output prompt sections, and fail-open empty results.
- `Routing`: Extracted cohesive inbound route composition from `index.ts` while preserving paired updates, controls, media, queueing, and edits.

## 0.3.0: Modular Runtime, Queue Controls, Diagnostics

- `Domain DAG`: Established one composition root over flat acyclic owners; session coordination remains in runtime instead of absorbing domain policy.
- `Queue Lifecycle`: Added typed lanes, active-turn state, readiness, abort and compaction guards, immediate controls, serialized control work, and reaction priority.
- `Controls`: Unified model, thinking, command, menu, callback, and in-flight model-switch policy; removed Telegram `/debug` in favor of local diagnostics.
- `Rendering`: Consolidated safe narrow-client HTML/Markdown rendering, splitting, tables, lists, quotes, code, previews, finals, and reply metadata.
- `Files And Setup`: Separated API retries/downloads, media grouping, attachment staging, config, pairing, authorization, and token setup.
- `Diagnostics`: Added grouped status plus a redacted runtime/API event ring across transport, dispatch, controls, typing, setup, and files.
- `Packaging`: Added package allowlists, lockfile, validation scripts, CI, broad regressions, and structural architecture guards.

## 0.2.x: Fork Genesis

- `Fork Identity`: Established the maintained package metadata and predictable saved-token, environment-token, then placeholder setup flow.
- `Domain Runtime`: Split the monolith into flat queue, replies, polling, updates, media, controls, API, setup, and status owners with mirrored tests.
- `Queue Lifecycle`: Added typed lanes, delayed admission, reactions, media groups, abort history, attachment-preserving edits, and compaction gates.
- `Polling And Updates`: Offsets follow successful handling, poisoned updates are bounded, and edits update queued turns instead of duplicating them.
- `Telegram Transport`: Added structured errors, retry/backoff, bounded streaming downloads, file-backed uploads, safe temp names, and cleanup.
- `Rendering And Controls`: Added safe narrow-client rendering, serialized previews, status/model/thinking menus, scoped models, and tool-safe switching.
- `Regression Foundation`: Established focused coverage for architecture, transport, rendering, queueing, media, previews, setup, controls, and lifecycle.
