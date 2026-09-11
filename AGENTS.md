# Project Context

## 0. Meta-Protocol Principles

- `Mobile companion boundary`: Telegram extends a running Pi session; it is not a remote terminal, PTY supervisor, process launcher, session browser, or replacement TUI. Never emulate Pi navigation through private internals, ANSI/TTY injection, or a shadow `pi` process.
- `Runtime safety`: Prefer explicit, fenced, recoverable behavior over shortcuts that can desynchronize Telegram transport, durable admission, local queue state, or Pi lifecycle state.
- `Pi-native extensibility`: Add capabilities through stable Pi and pi-telegram contracts. Do not fork polling, transport, menu ownership, or package-private runtime internals.
- `Bidirectional binding`: Treat Pi instance ↔ Telegram thread and bot ↔ client state as two-way relationships. Create, observe, repair, and reflect bindings on both surfaces.
- `Progressive enhancement`: Use richer Telegram/Pi capability when proven available and retain a useful fail-closed fallback when it is not.
- `Boundary clarity`: Keep Telegram transport, Pi integration, rendering/delivery, durable admission, extension APIs, and release/context state under distinct owners.

## 1. Product Contract

`pi-telegram` is a session-local Telegram runtime adapter for Pi: a private-DM operator surface for prompts, streaming previews, queue controls, settings, files, voice/buttons, and companion-extension interop. Its core loop is mobile continuation of a live Pi session.

Canonical terms:

- `Telegram turn`: One Telegram input unit processed by Pi, including a coalesced media group.
- `Queued` / `active Telegram turn`: Accepted-but-not-running / currently bound Pi work.
- `TelegramTarget`: `{ chatId, threadId? }`; classic private chats omit `threadId`.
- `Thread`: Product term for Telegram's tabbed private-chat surface. Use `topic` only for Bot API primitives.
- `Leader` / `follower`: The process owning `getUpdates` and direct Bot API transport / a registered process routing through that leader.
- `Instance slot`: Extension-owned `A`–`Z` ordering metadata, not the normal visible thread title. Naming and allocation details live in [`docs/multi-instance-bus.md`](./docs/multi-instance-bus.md).

## 2. Context Ownership

Keep each fact in one authoritative layer:

- [`README.md`](./README.md): Public product entrypoint. Preserve the flow identity → install/connect → examples → product model → compact capabilities → controls/safety → docs. Balance strong positioning with a practical catalogue; neither hide capabilities nor duplicate implementation docs.
- `AGENTS.md`: Stable engineering boundaries, recurring runtime invariants, and work protocol. Link to evolving subsystem contracts instead of copying them here.
- [`BACKLOG.md`](./BACKLOG.md): Canonical unresolved work. Keep only open top-level outcomes with nested decomposition and done criteria. Remove completed outcomes rather than retaining checked history.
- [`CHANGELOG.md`](./CHANGELOG.md): Completed user/operator/developer impact. A release has at most eight outcome bullets of at most 512 characters, each beginning with an inline-code domain label and colon. Exclude personal names and real user/chat/message/thread identifiers. Consolidate the current pre-release section before release; do not rewrite historical sections without an explicit retrospective request and evidence pass.
- [`docs/README.md`](./docs/README.md): Technical documentation index.
- [`docs/architecture.md`](./docs/architecture.md): Canonical runtime, domain-ownership, queue, journal, delivery, and lifecycle contract.
- [`docs/public-api.md`](./docs/public-api.md): Canonical public commands, config, markup, package entrypoints, and compatibility contract.
- [`docs/multi-instance-bus.md`](./docs/multi-instance-bus.md): Canonical Threaded Mode, leader/follower, binding, election, and transport protocol.
- Other `/docs` files own their named subsystem contracts; keep them reachable from `docs/README.md`.

## 3. Repository Topology And Local Skills

- `/index.ts`: Thin package entrypoint re-exporting the default extension.
- `/lib/extension.ts`: Sole extension composition root.
- `/api/*.ts`: Stable public package membranes documented in `docs/public-api.md`.
- `/lib/*.ts`: Flat, cohesive runtime domains; package-private unless re-exported through `/api`.
- `/tests/*.test.ts`: Domain-mirrored suites; `tests/integration.test.ts` owns cross-domain runtime flows.
- `/skills/telegram-bridge`: Stable agent operating protocol for Telegram turns, delivery, actions, Threaded Mode, and diagnosis.
- `/skills/generated-control-surface`: Optional state-derived, late-bound interface over truthful domain evidence, capabilities, workflows, and choices; it remains renderer-neutral, independent from the bridge skill, and owns no parallel state.
- `/skills/generative-apps`: Agent operating contract for compiling stable repeated Telegram interaction into deterministic standalone applications or bounded view/controller adapters whose buttons bypass model inference.
- `/skills/show-me`: Portable visual-explanation protocol with Telegram-aware phone-width Markdown and self-contained browser artifact guidance; it owns explanation shape and evidence honesty, not bridge transport.
- `/.agents/skills/telegram-bot`: Bot API lookup guidance and vendored `api.md`; keep the reference intact.
- `/.agents/skills/domain-dag`: Repository architecture guidance and validator.

Use the relevant local skill before non-trivial work in its domain. Keep skill operating guidance in its `SKILL.md`, not duplicated here.

## 4. Architecture And Runtime Invariants

### 4.1 Flat Domain DAG

- Cohesive domains live as flat `/lib/*.ts` modules whose local import graph is acyclic.
- `lib/extension.ts` constructs high-level runtimes and wires live ports. Domain policy, mutable state, sequencing, identity, retries, normalization, and lifecycle recovery belong to the owning `/lib` module.
- Extract only when ownership, substitution, independent testing/mutation, cycle pressure, or repeated coupling earns a boundary. Do not atomize a cohesive module or create one-use wrappers merely to shrink `index.ts`.
- `bindings` owns Pi-facing registration and narrow cross-domain assembly; it may connect established ports but must not absorb routing, rendering, transport, or mutable policy.
- `pi` owns direct Pi SDK imports and concrete adapter contracts. Other domains use narrow ports; domains that register Pi hooks/tools/commands consume contracts through that adapter.
- Do not introduce shared buckets such as `lib/constants.ts`, `lib/types.ts`, `lib/globals.ts`, or broad global-augmentation modules. Keep state, constants, registry keys, and concrete transport shapes with their domain owner.
- Every source `.ts` file starts with a brief responsibility header containing `Zones:` tags such as `telegram`, `pi agent`, `tui`, or `shared utils`.
- Use namespace imports for local domains in `lib/extension.ts` (`Queue.*`, `Turns.*`) and keep direct `node:*`, filesystem, process, and local-adapter mechanics in owning domains when one exists.

### 4.2 Ownership, Sessions, And Trust

- The bridge is session-local and paired to one allowed Telegram user. Preserve `{ chatId, threadId? }` through every inbound, queue, callback, reaction, media, preview, reply, menu, voice, attachment, and direct-delivery path.
- First-contact pairing grants in-memory authority only after profile/token/execution-fenced durable publication confirms that exact user; it never overwrites another configured owner. `profiles.<name>.botToken` may store an exact `$NAME`/`${NAME}` environment reference instead of a copied secret: resolve it only at validation or activation boundaries, fail closed with a redacted named-variable diagnostic when unresolved, and keep literal tokens compatible. Sender admission precedes user message/edit/callback/reaction delegation, including foreign ownership and unbound-Thread fallback paths. Reactions require an existing exact human owner; private chat type is not authorization. Queued config persistence must not replay observed authority as local grant edits or erase later local unpair. Setup and retry details belong in [`docs/architecture.md`](./docs/architecture.md#setup-flow).
- Telegram transport ownership is not semantic queue ownership. Losing the exact transport lock must not erase accepted local queue work or stop valid local Pi dispatch; direct Bot API mutations fail closed until exact direct or follower authority exists.
- `tmp/telegram/owners.json` is the sole transport-owner authority. Cross-process read/check/write operations serialize transactionally and acquisition, refresh, release, takeover, and irreversible leader work fence the exact owner/epoch. `state.json` and `logs.jsonl` are diagnostics, never routing authority.
- Threaded Mode has exactly one live leader per bot profile. Followers are real operator-started Pi processes and must authenticate/register over local IPC; Telegram never spawns hidden Pi processes. A live but unreachable owner does not authorize split-brain polling.
- Local IPC is a trust boundary, not merely a private socket. Unknown, stale, mismatched-generation, or unauthorized requests must not inject prompts, callbacks, API sends, artifacts, liveness, or bindings.
- Protocol compatibility is independent from package version. Registration negotiates protocol version, runtime build, and canonical capabilities before target provisioning or live publication. `durable-follower-admission-v1` gates source forwarding; `queue-handoff-v1` independently gates semantic queue transfer for every participant and is advertised only with exact source/recipient journal-binding composition. `follower.register` and capability-gated restore-only `follower.restoreWorkspace` are bootstrap requests; other requests require exact live-registry generation authority, and `bus.ack` is response-only. `thread-display-mode-v1` gates follower display-setting requests; the leader owns their serialized profile preference and title application.
- Long-lived timers, pollers, watchers, receivers, heartbeats, background delivery, and deferred dispatch are session-bound. Replacement stops stale activity and makes late work inert; same-process handoff may preserve exact profile/target identity but never stale Pi context or cross-profile authority. Aborting a durable update generation does not release that `update_id`: replacement replay waits for its actual handler settlement, and effectful handlers use the shared execution fence immediately before commit and after awaited delegation. Internal clones explicitly carry the hidden fence; reroute forwarding, thread-store mutation, cleanup, and Bot API boundaries retain the originating generation.
- Runtime state is event-driven reconciliation of local assumptions against Telegram signals, not a complete bot read-model and not permission to query Telegram on every action. Destructive thread cleanup goes through `thread-reconciler` with current proof and leader fencing. Fresh Workspace Thread creation derives its initial Bot API title from the active display mode before issuance; the stable generated `threadName` remains separate from the acknowledged `displayTitle`.

### 4.3 Durable Admission And Settlement

- Admission is journal-first: validate and persist the complete `getUpdates` response before one monotonic offset commit, then signal an independent worker without awaiting semantic execution. Missing cursor with a non-empty journal, malformed/foreign authority, or capacity exhaustion fails closed. “Durable” means process-crash recovery after atomic rename, not unflushed host/kernel/filesystem/device/power-loss survival.
- Workspace mutations acquire cross-process admission before their shared process-local gate and hold it through asynchronous API work and durable settlement. Topic lifecycle, complete unbound/reroute target handling, manual disconnect, and session-restart cleanup use profile-wide scope; either retained retirement-fence phase rejects them before state access. Cleanup scope spans intent publication, target mutation, persistence, and transport release. Detached reconciliation that mutates Thread state must reacquire fresh profile admission through the same gate; it cannot inherit a caller lease that ended before its timer runs. A live operation ID has one process-local caller: concurrent reuse is rejected before lease acquisition, while retry after the caller exits may resume exact durable authority.
- Workspace retirement is capacity-pressure-only. Elapsed time and heartbeat silence never trigger deletion; only complete `A`–`Z` exhaustion may propose the oldest continuously proven inactive, fully unprotected binding. Exact deletion, durable retirement, and fence completion precede slot reuse. Automatic retirement remains disconnected until separately authorized and operator-validated.
- Foreign forwarding settles as `accepted`, `retryable`, or `terminal-rejected`. Only an authenticated acknowledgement carrying the expected `deliveryId` and `sourceUpdateId` releases leader journal authority. Negative, missing, stale, mismatched, or capacity-failed settlement remains durable; callback error answers are side effects only.
- A forwarding delivery id is stable across registration replacement and derives from envelope kind, source `update_id`, and stable recipient binding. Runtime instance and registration generation remain separate attempt fences. Persisted message ownership carries the stable binding so replay can rebind only to its current authenticated registration.
- A queued receipt persists its acquiring runtime instance, OS pid/process-birth identity, session generation, acquisition id, and acquisition time. Only exact authority may settle or discard it. Same-process session replacement may reconstruct the claim and the original process may settle after transport ownership moves; a foreign process may neither replay nor settle it through generic removal or a copied acquisition id.
- Startup and elapsed time are not owner-death proof; queued authority has no time lease. Dead-owner cleanup groups the complete receipt and transactionally rechecks pid liveness plus process-birth identity: only an absent PID or mismatched stable Linux/macOS birth proof discards all session-owned sources without replay; a matching proof is `alive`, while Windows or inaccessible birth metadata is `unverifiable`, and both non-dead outcomes keep authority queued. The live-transfer contract is authenticated offer → exact-generation bounded payload staging → recipient CAS acceptance → exact receipt-and-owner ACK → donor removal → recipient readiness. The offer freezes donor settlement/recovery; controls rebuild local closures; negative/mismatched pre-acceptance ACK cancels only an unaccepted offer and retains donor work; a lost post-acceptance ACK cannot cancel recipient authority and leaves donor memory frozen for explicit reconciliation.
- Execution failures persist bounded diagnostics and attempt state as `retry-wait`, except that an exact Telegram HTTP 400 stale/deleted-thread API failure with a proven `{chatId, threadId}` terminally settles the currently executing source after best-effort shared binding invalidation. Automatic retry continues indefinitely with exponential `1s → 2s → 4s → 8s → 16s → 32s → 60s` delay capped at 60 seconds; later independent updates continue draining, durable authority is never silently discarded, and legacy `failed` entries resume automatically at startup. Snapshot-plus-segment journals compact only after 256 unapplied revisions or 4 MiB; snapshot-first cleanup tolerates redundant segments, and empty authority may atomically rebind bot/profile identity. Missing snapshots left by the retired broad temp cleanup rebuild only from a complete provably empty segment chain, while revisionless snapshots may recover from a validated later segment predecessor; otherwise the snapshot and segments move atomically under `tmp/telegram/recovery/` before a fresh journal is published and startup continues with informational recovery evidence.
- An unresolved reaction delays only the exact governed queue item identified by chat/message sources, not unrelated queue work. Queue receipt publication follows in-memory append and precedes dispatch request; receipt-bearing turns remain queued until every exact source commits.
- The detailed implementation and release gates live in [`docs/architecture.md`](./docs/architecture.md), [`docs/multi-instance-bus.md`](./docs/multi-instance-bus.md), and [`BACKLOG.md`](./BACKLOG.md).

### 4.4 Queue, Delivery, And User Surfaces

- Queue lane/kind admission is explicit. Dispatch waits for active-turn, pending-dispatch, control, compaction, `ctx.isIdle()`, and Pi pending-message guards; a dispatched prompt stays queued until `agent_start` consumes it. Each prompt is one object with one active lane and no reserved return slot. Normal and Priority are separate FIFO lanes: crossing lanes removes it from the source and appends it at the destination tail, while Keep/Skip and same-category emoji changes preserve lane position. Complete reaction sets independently derive Priority from recognized positive emoji and Skip from recognized negative emoji; both may coexist, suppressed turns retain durable receipts while waiting, and Skip settles them only when the prompt reaches dispatch before dropping it without inference. Suppressed turns remain visible at a struck-through physical ordinal without contributing to executable queue counters, while graceful session shutdown discards all remaining queue authority before clearing memory.
- `/stop`, `/abort`, `/next`, and `/continue` respectively reset+abort, abort while preserving queue, force the next turn, and enqueue a control-lane continuation. Abort-history folding applies only to Telegram-owned active turns.
- Telegram extension side effects must not hold Pi's core lifecycle hostage after semantic completion. Preserve ordering in extension-owned background work, record failures, and fence target/profile/transport/session authority.
- Complete assistant/guest model answers use Telegram-native Rich Markdown. Harness-owned menus, status, diagnostics, thinking, and tool evidence remain explicit HTML/plain or their documented native surface. Before Telegram preview or final delivery, strip every assistant-authored HTML comment regardless of Markdown position while keeping action activation top-level-only; a comment-only result sends no text message. Preserve literal code outside comments and structurally safe chunking; never split invalid markup.
- `preview` owns streaming lifecycle only, not assistant rendering. Finalization waits for active preview flushes and must not issue pre/post-final draft-clear calls that create transient Telegram draft UI. Turns that already answer as one atomic reply (voice replies, Guest Mode queries) never stream previews.
- Native `sendChatAction(typing)` is the automatic activity signal for unsettled agent and compaction work while Telegram transport is authorized. Extension-owned blocking UI prompts pause it and completion resumes it while either work owner remains active. Do not invent extra in-chat work indicators or emit activity for startup/connect/reload/recovery alone.
- Public activity handlers and connected companion delivery are asynchronous, target-bound, generation-fenced surfaces. Connected companion projection has no independent opt-out: disconnect or authority loss is its boundary. Token deltas, hidden reasoning, unknown sources, and stale authority never enter public projection.
- Thread display defaults to the profile-scoped Letters strategy, with Directories as the other automatic choice. A durable manual Thread display name retained on its Workspace binding overrides either until exact reset; keep generated/recovery identity separate from manual and acknowledged display fields. UI labels, emoji semantics, navigation, settings controls, callback namespaces, voice behavior, command templates, and assistant markup follow the linked `/docs` contracts. Generated human-readable prompt-button labels use `emoji + space + text`; emoji-free text is only a reasoned no-semantic-marker fallback. Non-spatial generated controls default to top-level vertical cells, with nested rows reserved for unmistakably compact peers. Do not restate other evolving UI details here.

## 5. Domain Ownership Index

The detailed map is canonical in [`docs/architecture.md`](./docs/architecture.md). This index is only for routing work:

- `queue`, `runtime`, `lifecycle`, `locks`: Scheduling, session coordination, lifecycle, and locking.
- `api`, `polling`, `bus*`, `ownership`, `target`, `sync`, `thread-reconciler`, `threads`, `updates`, `routing`, `media`, `turns`, `inbound`, `config`, `setup`: Telegram transport, profiles, durable admission, routing, and inbound flow.
- `preview`, `replies`, `rendering`, `keyboard`, `delivery`, `activity`, `outbound*`, `voice`, `status`: Response and delivery surfaces.
- `commands`, `menu*`, `model`, `prompts`: Controls and application-menu UI; core queue mechanics remain in `queue`.
- `sections`, `delivery`, `activity`, `voice`: Extension registries/runtime membranes for their named capabilities. `Companion` describes consumers, not a source-domain owner.
- `pi`, `bindings`: Pi SDK boundary and Pi-facing registration/composition.

## 6. Public And Integration Boundaries

- Companion extensions use documented package subpaths such as `@llblab/pi-telegram/sections`, `/delivery`, `/voice`, `/inbound`, `/outbound`, and `/updates`; never import `lib/*.ts`.
- Low-level handler buses have no caller-supplied ids; high-level registries use stable identities. Imperative delivery resolves the current runtime on every call and returns generation-bound logical handles rather than captured Pi contexts.
- Extension sections receive only documented context ports. They do not access raw bot clients/filesystems or run a second polling loop; unregister on shutdown.
- Unknown callback data may reach extension handlers only after built-in namespaces decline it. Follow [`docs/callback-namespaces.md`](./docs/callback-namespaces.md).
- Command templates remain compact and shell-free. Use string leaves or ordered `template` arrays; shell operators are not an execution contract. Examples use portable executable placeholders, never machine-local paths.
- `telegram_attach` is the canonical file path and `telegram_message` the direct Markdown text/buttons path. Both require current direct or registered-follower authority and must not replace the normal active-turn reply.
- Inbound handlers transform text/media before queueing; outbound handlers precede programmatic/provider fallbacks. Public contracts and ordering live in `docs/inbound.md`, `docs/outbound.md`, and `docs/public-api.md`.
- Pi integration uses public hooks and APIs. A Telegram `/new` or equivalent session replacement requires a public Pi API that executes the real terminal path.

## 7. Engineering Conventions

- Keep comments and user-facing docs in English. Comment non-obvious rationale/contracts, not names or standard idioms.
- Name flat modules by bare domain (`queue.ts`, `queue.test.ts`); `telegram-api.ts` is the intentional transport exception. Tests primarily protect their mirrored module; shared fixtures require real cross-suite reuse.
- Keep interfaces consistent with their owning exported contract. Use local structural `*Like`/view types only for deliberate narrow projections, not duplicate source-of-truth models.
- Remove dead code immediately. Reachability from composition roots, public exports, tests, registered surfaces, and documented APIs—not recent usefulness—determines whether code is live.
- Treat every meaningful `lib/extension.ts` edit as a composition-pressure check, but keep one-off live adapter wiring there when extraction would only hide cross-domain state.
- Follow [`docs/ui-style.md`](./docs/ui-style.md) for interface copy, emoji, buttons, menus, and dialogs. Update the registry before assigning a new UI emoji meaning. Standalone notices use one fully bold emoji-led sentence with a terminal period; menu or chooser headings use the same hierarchy with a terminal colon. Material names may add nested italic emphasis without breaking the outer bold span. Callback alerts preserve equivalent emoji-led plain text because Telegram does not support rich formatting there.
- Markdown lists never contain blank lines between adjacent items; list items are not paragraphs. Use blank lines only between paragraphs or independently separated blocks. Markdown tables use compact source formatting with `---` separator cells and one surrounding space per cell. Preserve vendored references unchanged.
- Treat Windows filesystem, named-pipe, lock, heartbeat, and atomic-rename reports as high-signal evidence; reduce them to regressions or explicit platform caveats.
- Route significant runtime failures through the redacted recent-event recorder. Keep the compact TUI status at generic `error`; details belong in diagnostics.

## 8. Work Protocol

Before non-trivial work:

1. Read `README.md` for current product behavior and positioning.
2. Read `BACKLOG.md` before runtime or documentation changes.
3. Read the relevant indexed docs; read `docs/architecture.md` before architecture, queue, preview, rendering, lifecycle, or command restructuring.
4. Inspect the owning module, its callers, mirrored tests, and the relevant `lib/extension.ts` wiring before editing.
5. Run an `AGENTS.md` compliance pass for implementation, release, and architecture work; update an obsolete rule instead of silently working around it.

While working:

- Keep changes inside this repository; updating an installed Pi checkout is a separate operator action.
- Read large artifacts search-first and range-bounded. For `CHANGELOG.md`, inspect only the current release section unless older history is relevant.
- Keep successful validation output compact; inspect focused failure tails. Prefer focused tests/typecheck during iteration and broad validation at a stable gate.
- Preserve unrelated work and do not commit, publish, tag, deploy, or perform external actions without explicit authorization.

Before completion:

- Run the smallest decisive validation for the affected closure. Queue/rendering/lifecycle changes normally require `npm run typecheck` and `npm test` at the stable gate.
- For Domain DAG changes, run `SKILL_DIR=.agents/skills/domain-dag bash .agents/skills/domain-dag/scripts/validate-domain-dag.sh --root .`.
- Keep strict unused-local/parameter checking. Validate queue dispatch around abort, compaction, pending dispatch, and Pi pending-message guards; validate rendering around literal code, nesting, and long-message chunks.
- When context files change, run the ABCd context validator and review warnings rather than relying on exit status alone.
- Sync `README.md`, `CHANGELOG.md`, `BACKLOG.md`, and relevant `/docs` only when behavior, shipped impact, open-work truth, or durable contracts actually changed.
- Do not call a release ready until its canonical backlog gates and required platform/live evidence are complete.
