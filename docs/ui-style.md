# UI Style Guide

Small standard for inline buttons, menu rows, state controls, cards, and confirmation dialogs.

## Principles

- Keep UI compact and phone-readable.
- Put emoji where they help scanning, not everywhere.
- Use one strong indicator for current selection; avoid emoji noise on every option.
- Match label casing to control role.
- Prefer minimal, clear configuration UI over exhaustive explanation.
- Preserve domain-owned callback prefixes and behavior in the owning module.

## Emoji Semantics

Use emoji as stable semantic markers, not decoration. Emoji carry transportable meaning across command descriptions, inline menu rows, message headings, status copy, and tests. Before adding a new UI emoji, either reuse one below or extend this registry in the same change.

### Domain Markers

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🧵` | Telegram/Pi thread routing | Thread chooser headings, unbound-thread warnings, thread lifecycle/status copy | Canonical thread marker. Do not add it to every concrete target button; target buttons use `threadName` or slot fallback. |
| `📡` | Telegram transport / bridge connection | Instance connected notices, polling/transport role, bridge online copy | Transport is not thread identity; use `🧵` for thread concepts. |
| `📊` | Status / overview | `/status` command description, status cards or status rows | Use for status summaries, not queue priority. |
| `🤖` | Model selection | `/model`, model menu headings, model status rows | Keep model-control surfaces visually distinct from thinking. |
| `🧠` | Thinking level | `/thinking`, thinking menu headings, thinking status rows | Use only for reasoning/thinking controls. |
| `🔢` | Queue list / ordered work | `/queue`, queue menu entrypoints | Queue item rows may also use numeric labels. |
| `⏱️` | Queue is ticking / current work is active | Inline main-menu Queue row only | Running-clock queue state: the narrow present moment is being worked now. |
| `⏳` | Queue has waiting prompts | Inline main-menu Queue row only | Hourglass queue state: sand above the neck is future work still waiting. |
| `⌛` | Queue is empty / standing idle | Inline main-menu Queue row only | Standing hourglass queue state: no future work is waiting above the neck. |
| `⚙️` | Settings / configuration | Settings menu headings and Settings navigation rows | Extension-injected rows appear before the built-in `⚙️ Settings` row. |
| `🧩` | Extension-provided surface | Extension command examples, extension section examples | Companion extensions may choose their own emoji, but `🧩` means generic extension/plugin. |
| `👄` | Voice reply policy | Voice reply settings row and detail card | Not a generic audio attachment marker. |
| `🕒` | Time injection / wall-clock context | Time injection settings row and detail card | Clock-face marker with hands; not a generic duration/progress marker. |
| `📌` | Proactive push / pinned behavior | Proactive push settings row and detail card | Not generic active/selected state. |
| `📎` | Attachment | Attachment summaries, queue rows for attachment-only turns | Not for thread binding. |

### Command And Control Actions

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🟢` | Start / active / current positive state | `/start`, active row, current selected option, active `On` toggle | In command context it means “open/start menu”; in state context it means selected/active. |
| `🗜` | Compact session | `/compact`, compact confirmation action | Do not use for generic cleanup/delete. |
| `⏩` | Force next queued turn | `/next` command and matching menu action | Means skip/advance to next waiting item. |
| `▶️` | Continue/resume generation | `/continue` command and matching menu action | Means resume/continue current session flow, not force-next. |
| `⏹️` | Abort current Pi work | `/abort` command description | Stops active work but is not a destructive queue clear by itself. |
| `🟥` | Stop / abort-and-clear danger | `/stop` command description | Stronger than `⏹️`; use for disruptive stop/clear semantics. |
| `🆕` | New session / fresh start | Reserved visible extension command example for `/new`-like flows | Same-thread Telegram `/new` is currently blocked by Pi core API; keep this meaning reserved. |
| `🌀` | Refresh | Queue refresh row and future refresh buttons | Re-fetch/re-render current surface, not transport reconnect. |
| `↪️` | Reroute to an existing target | Thread chooser buttons that send a captured command/message from one thread to another live thread | Curved arrow means the message arrived here but bends to another target. |
| `🔁` | Replace/restore mode | Thread replace/restore chooser entrypoints | Opens a second step for moving a Pi instance binding to the current source thread. |
| `➡️` | Choose replacement target | Thread replace/restore target buttons that select which Pi instance should move to the current thread | Use inside the second replace/restore chooser, not for ordinary reroutes. |
| `☑️` | Activate / choose this item | Model detail activation action | Positive action; use `🟢 Active` for already-current state. |
| `❌` | No / cancel | Confirmation cancel buttons | Use for safe cancellation, not destructive removal. |
| `🗑` | Delete / remove | Queue delete actions, destructive confirmations, remove reaction | Use only when something is removed/closed/deleted. |

### State Indicators And Button Grammars

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🟢` | Current/active/enabled `On` | Current option in vertical lists, active state rows, active `On` toggle | One strong current marker per option list. |
| `🟡` | Active `Off` or elevated/filter state | Active `Off` toggle, Priority/Scoped active tab | Yellow means intentionally not-normal or off/default-caution, not error. |
| `🟣` | Normal/default active tab | Normal priority tab, All/default scope tab, active page picker | Use for neutral active tabs. |
| `⚫️` | Inactive placeholder | Inactive toggle values and inactive tabs | Keeps row width stable. |
| `⬆️` | Navigate upward | `⬆️ Main menu`, `⬆️ Back` | Always first row in submenus. |

### Queue Reaction Shortcuts

Queue reactions are shortcut controls for waiting turns. Preserve their semantics across Telegram reactions, queue-menu rows, status previews, and tests.

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `👍` | Promote to priority | Queue reaction shortcut | Normalized from variants like `👍️`. |
| `⚡` | Promote to priority / fast lane | Queue reaction shortcut, priority fallback badge | Also used as the default priority badge when no specific priority emoji is stored. |
| `❤` / `❤️` | Promote to priority | Queue reaction shortcut | Normalize display consistently where code normalizes reactions. |
| `🕊` / `🕊️` | Promote to priority | Queue reaction shortcut | Soft/peaceful promotion gesture. |
| `🔥` | Promote to priority | Queue reaction shortcut | Urgent/hot promotion gesture. |
| `👎` | Remove waiting turn | Queue reaction shortcut | Removal, not negative feedback to the agent. |
| `👻` | Remove waiting turn | Queue reaction shortcut | Disappear/remove metaphor. |
| `💔` | Remove waiting turn | Queue reaction shortcut | Removal/cancel metaphor. |
| `💩` | Remove waiting turn | Queue reaction shortcut | Removal/reject metaphor. |
| `🗑` | Remove/delete waiting turn | Queue reaction shortcut and queue delete UI | Same destructive semantics as delete buttons. |

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
- `📌 Proactive push: On` — settings row, opens the toggle submenu
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

## Vertical Option Lists

Vertical option lists choose one value from a potentially longer list, for example model selection, thinking level, voice reply mode, or time injection mode.

Rules:

- Put each option on its own row.
- Mark only the current value with `🟢`.
- Leave non-current values without emoji.
- Use lowercase labels when the option is a value.

Examples:

- `🟢 mirror`
- `manual`
- `always`

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

Message cards sent by the bot should start with a strong heading.

Rules:

- Start with a bold heading or, for dialogs, a bold question.
- Setting detail cards may include an emoji in the heading, then a colon and the current value in `<code>`.
- Explain what the setting does and what the options mean only as much as needed.
- Keep descriptions short and clear.

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
