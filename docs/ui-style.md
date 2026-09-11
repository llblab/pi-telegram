# UI Style Guide

Small standard for inline buttons, menu rows, state controls, cards, and confirmation dialogs.

## Principles

- Keep UI compact and phone-readable.
- Put emoji where they help scanning, not everywhere.
- Use one strong indicator for current selection; avoid emoji noise on every option.
- Match label casing to control role.
- Keep Telegram bot commands such as `/start` and `/abort` as plain text so clients expose their native command links; bot command names use Telegram-compatible characters and never hyphens. Render Pi TUI commands mentioned inside Telegram HTML, such as `<code>/telegram-connect</code>`, as code so Telegram does not mis-tokenize their hyphenated names; callback alerts remain plain because Telegram does not support rich formatting there.
- Prefer minimal, clear configuration UI over exhaustive explanation.
- Preserve domain-owned callback prefixes and behavior in the owning module.

## Emoji Semantics

Use emoji as stable semantic markers, not decoration. Emoji carry transportable meaning across command descriptions, inline menu rows, message headings, status copy, and tests. Before adding a new UI emoji, either reuse one below or extend this registry in the same change.

### Domain Markers

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🧵` | Telegram/Pi thread routing | Thread chooser headings, unbound-thread warnings, thread lifecycle/status copy | Canonical thread marker. Do not add it to every concrete target button; target buttons use the acknowledged display title or stable-name fallback. |
| `📡` | Telegram transport / bridge connection | Instance connected notices, polling/transport role, bridge online copy | Transport is not thread identity; use `🧵` for thread concepts. |
| `📊` | Status / overview | `/status` command description, status cards or status rows | Use for status summaries, not queue priority. |
| `🤖` | Model selection | `/model`, model menu headings, model status rows | Keep model-control surfaces visually distinct from thinking. |
| `🧠` | Thinking level | `/thinking`, thinking menu headings, thinking status rows | Use only for reasoning/thinking controls. |
| `🔢` | Queue list / ordered work | `/queue`, queue menu entrypoints | Queue item rows may also use numeric labels. |
| `⏱️` | Queue is ticking / current work is active | Inline main-menu Queue row only | Running-clock queue state: the narrow present moment is being worked now. |
| `⏳` | Waiting / temporarily busy | Inline main-menu Queue row, busy notices | Hourglass means work or availability is pending; the sentence must name what is busy. |
| `⌛` | Empty / standing idle | Inline main-menu Queue row, empty-queue notices | Standing hourglass means no future work is waiting above the neck. |
| `⚙️` | Settings / configuration | Settings menu headings and Settings navigation rows | Extension-injected rows appear before the built-in `⚙️ Settings` row. |
| `🧩` | Extension-provided surface | Extension command examples, extension section examples | Companion extensions may choose their own emoji, but `🧩` means generic extension/plugin. |
| `👄` | Voice reply policy | Voice reply settings row and detail card | Not a generic audio attachment marker. |
| `🕒` | Time injection / wall-clock context | Time injection settings row and detail card | Clock-face marker with hands; not a generic duration/progress marker. |
| `🔬` | Activity / technical detail | Activity settings row and detail card | Chooses quiet, thinking, tools, or verbose bridge activity; not a generic diagnostics marker. |
| `🧠` | Model thinking controls | Thinking menus and status rows | Thinking activity quotes omit this icon and their header entirely to minimize chat height. |
| `📎` | Attachment | Attachment summaries, queue rows for attachment-only turns | Not for thread binding. |

### Command And Control Actions

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🟢` | Start / active / current positive state | `/start`, active row, current selected option, active `On` toggle | In command context it means “open/start menu”; in state context it means selected/active. |
| `🗜` | Compact session | `/compact`, compact confirmation action | Do not use for generic cleanup/delete. |
| `⏩` | Abort and advance | Busy `/next` command result and matching menu action | Means the active turn is aborted before advancing to queued work. |
| `▶️` | Play / continue immediately | Idle `/next` result, `/continue` command, and matching menu action | Means work can start or resume directly without first aborting an active turn. |
| `⏹️` | Abort current Pi work | `/abort` command description and active `/stop` result | Stops active work; accompanying copy states separately when queued work is cleared. |
| `🟥` | Destructive stop command | `/stop` command description | Strong warning at the command/action entrypoint; standalone results use the more precise idle or abort state icon. |
| `🆕` | New session / fresh start | Reserved visible extension command example for `/new`-like flows | Same-thread Telegram `/new` is currently blocked by Pi core API; keep this meaning reserved. |
| `🔄` | Refresh | Queue refresh row and future refresh buttons | Re-fetch/re-render current surface, not transport reconnect. |
| `↪️` | Reroute to an existing target | Thread chooser buttons that send a captured command/message from one thread to another live thread | Curved arrow means the message arrived here but bends to another target. |
| `🔁` | Replace/restore mode | Thread replace/restore chooser entrypoints | Opens a second step for moving a Pi instance binding to the current source thread. |
| `➡️` | Choose replacement target | Thread replace/restore target buttons that select which Pi instance should move to the current thread | Use inside the second replace/restore chooser, not for ordinary reroutes. |
| `☑️` | Activate / choose this item | Model detail activation action, generated button-only choice heading | Positive selection cue; use `🟢 Active` for already-current state. |
| `❌` | No / cancel / terminal failure | Confirmation cancel buttons and terminal failure notices | Do not use for a recoverable operation failure that leaves session state intact. |
| `🗑` | Delete / defer removal | Destructive confirmations and removal reaction | In the queue menu, reversible Keep/Skip selectors replace immediate deletion. |

### Informational Feedback

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `💤` | Nothing active | No-active-turn notices | Neutral idle result, not an error. |
| `✅` | Completed successfully | Compaction and other completion notices | Use only after the operation has completed. |
| `🚫` | Unavailable, denied, or cancelled operation | Missing capability/auth notices, access denial, and compaction cancellation | Callback alerts use the same emoji without bold markup. |
| `⚠️` | Recoverable operation failure | Compaction failure notice | The attempted operation failed, but the original session state remains usable. |

### State Indicators And Button Grammars

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🟢` | Current/active/enabled `On` | Current option in vertical lists, active state rows, active `On` toggle | One strong current marker per option list. |
| `🟡` | Active `Off` or elevated/filter state | Active `Off` toggle, Priority/Scoped active tab | Yellow means intentionally not-normal or off/default-caution, not error. |
| `🔴` | Active destructive/deferred disposition | Active queue `Skip` selector | Red distinguishes a prompt that will be discarded at dispatch from reversible neutral or elevated state. |
| `🟣` | Normal/default active tab | Normal priority tab, All/default scope tab, active page picker | Use for neutral active tabs. |
| `⚫️` | Inactive placeholder | Inactive toggle values and inactive tabs | Keeps row width stable. |
| `⬆️` | Navigate upward | `⬆️ Main menu`, `⬆️ Back` | Always first row in submenus. |

### Queue Reaction Shortcuts

Queue reactions are shortcut controls for waiting turns. Preserve their semantics across Telegram reactions, queue-menu rows, status previews, and tests. Positive emoji control the Priority/Normal lane; negative emoji control Keep/Skip. These categories are independent, may coexist, and mutate only their own dimension. Crossing lanes appends the prompt at the destination FIFO tail; changing Keep/Skip or changing emoji within one category preserves lane position. Skip wins only when dispatch reaches the prompt.

Skipped queue ordinals strike only the numeric position. Detail HTML closes `<s>` before the period; list-button labels place a hair-space boundary between the combining-struck number and the plain period so Telegram font overhang cannot visually strike punctuation.

Queue item detail renders two independent selector rows:

- `🟡 Priority` / `⚫️ Normal` or `⚫️ Priority` / `🟣 Normal` selects the lane.
- `🟢 Keep` / `⚫️ Skip` or `⚫️ Keep` / `🔴 Skip` selects dispatch disposition.

The menu may clear internal Skip but cannot remove a reaction created by the user through Telegram's Bot API.

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `👍` | Promote to priority | Queue reaction shortcut | Normalized from variants like `👍️`. |
| `⚡` | Promote to priority / fast lane | Queue reaction shortcut, priority fallback badge | Also used as the default priority badge when no specific priority emoji is stored. |
| `❤` / `❤️` | Promote to priority | Queue reaction shortcut | Normalize display consistently where code normalizes reactions. |
| `🕊` / `🕊️` | Promote to priority | Queue reaction shortcut | Soft/peaceful promotion gesture. |
| `🔥` | Promote to priority | Queue reaction shortcut | Urgent/hot promotion gesture. |
| `👎` | Defer removal of waiting turn | Queue reaction shortcut and queue emoji marker | Reversible until the marked turn reaches dispatch; not negative feedback to the agent. |
| `👻` | Defer removal of waiting turn | Queue reaction shortcut and queue emoji marker | Disappear/remove metaphor. |
| `💔` | Defer removal of waiting turn | Queue reaction shortcut and queue emoji marker | Reversible cancel metaphor. |
| `💩` | Defer removal of waiting turn | Queue reaction shortcut and queue emoji marker | Reversible reject metaphor. |
| `🗑` | Defer removal | Queue reaction shortcut and queue emoji marker | Like Skip, the reaction remains reversible until dispatch reaches the marked turn. |

### Decorative Or Local-Example Emoji

Some emoji are intentionally local examples or decorative variants, not global semantics. Empty-queue rotating messages (`🫙`, `🍃`, `🕳`, `🦗`, `🌙`, `🧘`, `🪐`, `🧺`, `🔭`, `🫧`, `🛸`) are copy flavor only and must not become controls. Example extension icons such as `🧪`, `🔧`, and `🗂` are documentation fixtures for companion extensions, not built-in pi-telegram meanings.

Thread UI rule: when a message heading, chooser, or status line is specifically about Telegram/Pi threads or target thread selection, start the heading with `🧵`. Button labels for concrete thread targets should stay clean (`threadName` or slot fallback) and should not add `🧵` to every target button unless the row would otherwise be ambiguous.

## Action Buttons

Action buttons perform an operation.

Rules:

- Use an emoji plus capitalized action text.
- Prefer direct verb or action noun.
- Keep labels short.

Examples:

- `🗜 Yes, compact`
- `❌ No`
- `🗑 Yes, delete`
- `☑️ Activate`

## State & Navigation Buttons

State buttons show the current state and navigate to a submenu or detail rather than performing an operation directly.

Rules:

- Use an emoji that reflects the current state.
- Use Capitalized, descriptive state text.
- Tapping opens a submenu or returns to the parent list.

Examples:

- `🟢 Active` — model detail, navigates back to model list
- `👄 Voice reply: Mirror` — settings row, opens the option list

## Boolean Toggles

Boolean settings use a horizontal `On` / `Off` pair.

Rules:

- Keep the pair in one row: `On` left, `Off` right.
- Use Capitalized labels.
- Always show an indicator on both buttons to avoid horizontal label shift.
- Mark active `On` with `🟢`.
- Mark active `Off` with `🟡`.
- Mark the inactive value with `⚫️`.

Examples:

- `🟢 On` / `⚫️ Off`
- `⚫️ On` / `🟡 Off`

## Horizontal Tabs

Tabs or small mutually-exclusive scopes use a horizontal row.

Rules:

- Use Capitalized labels.
- Always show an indicator on every tab to avoid horizontal label shift.
- Use active tab color to convey semantics:
  - `🟣` for the default / normal state (All models, Normal priority).
  - `🟡` for an elevated or filtered state (Scoped models, Priority).
  - `🟣` for neutral navigation controls (page picker).
- Mark inactive tabs with `⚫️`.

Examples:

- `🟡 Scoped` / `⚫️ All`
- `⚫️ Priority` / `🟣 Normal`
- `1` / `🟣 2` / `3`

## Option Lists

Option lists choose one value from a fixed set, for example model selection, thinking level, voice reply mode, or time injection mode.

Rules:

- Put each option on its own row when labels are long, the set may grow, or scanning benefits from full width.
- A fixed set of short, ordered peer values may use compact rows of up to three buttons.
- Keep a semantically distinct value such as thinking `off` on its own full-width row before grouped intensity values.
- Mark only the current value with `🟢`.
- Leave non-current values without emoji.
- Use lowercase labels when the option is a value.

Examples:

- Vertical: `hidden`, `🟢 mirror`, `always`.
- Thinking: full-width `off`, then `minimal` / `low` / `🟢 medium`, then `high` / `xhigh` / `max`.

## Generated Prompt Buttons

A button-only assistant reply uses the standard Rich Markdown heading `☑️ **Choose an option:**`: semantic icon first, one space, bold heading text, and a final colon. Every generated human-readable action label starts with the most semantically appropriate emoji, one ASCII space, then concise action text. Emoji selection is part of authoring the control, including compact label-equals-prompt forms. Emoji-free text remains a syntax-compatible fallback only when no honest semantic marker exists after considering the action, domain, and state—not merely for convenience or label pressure; genuine coordinate and symbolic spatial controls retain their established grammar. Generated non-spatial controls default to vertical full-width buttons represented as top-level matrix cells. Nested row arrays are a compact-peer exception only when every label is unmistakably short—roughly 15 visible characters or fewer including emoji and space; this is a judgment heuristic rather than a mechanical count, and any plausible ellipsis or wrapping risk returns the controls to vertical rows. Assistant-generated prompt buttons use the default app style before selection. After queue admission, edit only the selected button to its agent-configured `selected_style`: `primary` (default/blue), `success` (green), or `danger` (red). Preserve its agent-authored text and emoji, leave other choices at their default style, and always queue the selected prompt regardless of color. The callback acknowledgement remains the compatibility fallback when a client does not render button styles.

## Navigation

Inline submenu navigation is hierarchical.

Rules:

- Put the navigation row first.
- First-level submenus opened from the main inline menu start with `⬆️ Main menu`.
- Deeper submenus start with `⬆️ Back`.
- `Main menu` returns to the root inline menu.
- `Back` returns one level up, never directly to the root unless the parent is the root.

Examples:

- Main menu → Settings: first row is `⬆️ Main menu`.
- Settings → Voice reply mode: first row is `⬆️ Back`.

## Message Cards

Message cards and standalone informational notices sent by the bot should start with a strong heading.

Rules:

- Start with a bold heading or, for dialogs, a bold question.
- Format standalone notices as one fully bold line: relevant emoji, one space, concise sentence, and terminal period. Menu or chooser headings use the same fully bold form but end in a colon when controls or detail follow.
- Keep the emoji and complete sentence or heading inside the single bold span; do not bold only a fragment. A material name or phrase may receive nested italic emphasis without breaking the outer bold hierarchy—for example `<b>📡 Instance <i>Cedar</i> connected.</b>`.
- Apply the same hierarchy to success, progress, empty, busy, unavailable, cancellation, and failure notices.
- Callback alerts remain plain text because Telegram does not support rich text there, but still keep the relevant emoji and concise sentence.
- Setting detail cards may include an emoji in the heading, then a colon and the current value in `<code>`.
- Explain what the setting does and what the options mean only as much as needed.
- Order setting value descriptions exactly like the chooser: rows top-to-bottom and values in a shared row left-to-right. Keep `(default)` on the actual default wherever it falls; default status never changes order.
- Keep descriptions short and clear.
- Automatic Thread display uses the same setting card: current value in `<code>`, then descriptions ordered `letters`, `names`, `directories`, with `(default)` only on `letters`. Its vertical chooser marks only the current option. A manual `/name Name` sets the current Thread display name and supersedes any automatic projection until reset; switching automatic mode preserves the slot and override.

Examples:

```html
<b>👄 Voice reply mode:</b> <code>mirror</code>
```

```html
<b>Queue</b>
```

## Confirmation Dialogs

Confirmation dialogs protect risky or disruptive actions.

Rules:

- Body text is one bold text-only question.
- Do not put emoji in the dialog question.
- Do not add explanatory body copy unless the risk cannot be understood from the question and action labels.
- Put emoji on the buttons, not in the question.
- Preserve dialog-specific button order by intent.

Example:

```html
<b>Compact session?</b>
```

Buttons:

- `🗜 Yes, compact`
- `❌ No`

## Callback Ownership

UI style does not change callback ownership. Callback prefixes remain owned by their feature domain and must be listed in callback namespace documentation when they become public collision risks.
