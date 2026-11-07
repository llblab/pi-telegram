# Callback Namespace Standard

Telegram `callback_data` is one bot-wide namespace. Any extension that creates inline buttons for a bot shared with `pi-telegram` must use namespaced callback data.

## Format

```text
<namespace>:<action>[:<payload>]
```

Examples:

```text
vividfish:approve:123
vividfish:deny:123
myext:page:2
```

## Rules

- Use a stable extension-owned namespace, preferably the package or extension name without scope punctuation.
- Keep the namespace lowercase ASCII: `a-z`, `0-9`, `_`, `-`.
- Do not use `pi-telegram` owned prefixes: `compact:`, `new:`, `quit:`, `tgbtn:`, `tgconfirm:`, `tgchoice:`, `tginput:`, `tgattach:`, `tgtask:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, `section:`, `reroute:`, `reroutemenu:`, `rerouteroot:`, `reroutenew:`, `rerouterestore:`, `reroutecancel:`. The `reroute*` family belongs to exact-source unbound Thread choosers; `reroutecancel:` retains an eligible owner's original before cancelling its routing authority. Its `review:` branch owns Status recovery for protected cancellation attempts; `history:` remains reserved only to reject retired historical-review controls. Action payloads carry a fresh bounded view nonce and an index, never caller-supplied journal paths or source authority. Current app navigation uses `menu:`; `status:` remains reserved for legacy/owned status callbacks but is not emitted by current UI. `compact:` and `new:` remain reserved legacy command namespaces: their old confirm/cancel controls are consumed as expired, never executed. Current `/new`, `/compact`, and hidden `/quit` questions use Delivery-owned `tgconfirm:` controls; unbound `quit:confirm|cancel` is likewise rejected. `section:` is owned by the Extension Sections platform (0.10.0+), documented in [Extension Sections](./sections.md). `settings:` is owned for the built-in Settings submenu.
- `tgbtn:expired` and `tgbtn:capacity` are refusal-only statuses for known deadline expiry and capacity removal. Neither resolves to an action, consumes a callback slot or grants prompt/app admission. Missing ordinary `tgbtn` history is unavailable, not evidence of elapsed TTL; do not invent a retained-action registry or replay from a status marker.
- `tgconfirm:<nonce>:yes|no` belongs to explicit Delivery confirmation requests. It is process-local, exact-message/target/session-bound and one-shot; stale or malformed reserved controls are consumed as expired, never forwarded as prompts. The nonce carries no operation-execution authority.
- `tgchoice:<nonce>:<index>|cancel` belongs to explicit Delivery Choice requests. The index addresses the immutable option snapshot; IDs never become wire actions. Exact operator/message/target/profile/generation and one-shot rules match Confirm; disabled, malformed, stale and wrong-kind controls never fall back to model prompts.
- `tginput:<nonce>:cancel` is reserved for private Delivery Text Input cancel/status controls. Terminal views retain an inspectable status control as non-authoritative reply provenance; absent, stale or malformed receivers are consumed as unavailable, never prompts. A marker cannot restore a receiver or authorize input/execution. The public Text Input entrypoint remains gated.
- `tgattach:<nonce>:cancel` is reserved for private Attachment question cancel/status controls. Malformed, stale and unbound controls never become model prompts. Cancellation retires only the question, not file leases or source pins. A status marker is not reply admission; production publication/readiness and the public Attachment opener remain gated.
- `tgtask:<nonce>:cancel` belongs to explicit Delivery Task Views. It requests producer cancellation once for the exact original live operator/profile/target/message; it does not execute, abort Pi or prove that work stopped. Terminal intent, closed, malformed, stale and unbound controls are consumed as unavailable, never model prompts. Producer acknowledgement/completion remains separate.
- Keep the full `callback_data` within Telegram's 64-byte limit.
- Put only opaque ids or small enum values in payloads; do not store secrets, full prompts, or large state.
- Treat callbacks as untrusted input. Validate namespace, action, and payload before executing side effects.

## Queue Controls

The Steer surface owns `queue:lane-set:<chat>:<message>:steer|priority|normal` and independent `queue:skip-set:<chat>:<message>:keep|skip`. Previously published `queue:prio-set` and `queue:prio` controls remain explicit Priority/Normal compatibility routes. Payloads only identify a current view; they cannot grant source/session authority or edit a protected pending/frozen item. Control lanes remain producer-owned.

## pi-telegram fallback

If `pi-telegram` receives callback data that is not owned by its built-in prefixes and no built-in handler consumes it, it forwards the click to Pi as:

```text
[callback] <callback_data>
```

Layered extensions may intercept that message and handle their own namespace. If no extension handles it, the assistant may see the fallback message and should tell the user the callback was not handled and the environment may be misconfigured.

## Extension sections

[Telegram Extension Sections](./sections.md) are a higher-level UI contract over this namespace rule. A section owns a canonical extension identity such as `@llblab/pi-telegram-explorer`, but its Telegram `callback_data` should use the `pi-telegram` owned `section:` prefix plus a compact token, because Telegram limits callback payloads to 64 bytes.

Conceptual form:

```text
section:<token>:<action>[:<payload>]
```

The token maps back to the full section identity inside the section registry. Section authors should not hand-roll `section:` callbacks outside the section context helpers, and ordinary layered extensions should continue using their own namespace plus update handlers or the `[callback]` fallback.
