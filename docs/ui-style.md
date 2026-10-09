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
| `🧵` | Telegram/Pi thread | Unbound-thread warnings, thread lifecycle/status copy, and concrete thread target buttons in the Reroute and Restore submenus | Canonical thread marker. In route submenus the action lives in the heading and every target button is a thread, so each one carries `🧵` before its acknowledged display title or stable-name fallback. |
| `🚦` | Routing decision | Root route chooser heading in unbound or temporary tabs (`🚦 Route this message:`) | The heading only asks for a decision; the buttons name each available action. |
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
| `👁` | Read-only inspection | State/detail viewers and inspection entrypoints | Opens evidence without mutating the inspected object; do not use for edit or refresh actions. |

### Command And Control Actions

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🟢` | Start / active / current positive state | `/start`, active row, current selected option, active `On` toggle | In command context it means “open/start menu”; in state context it means selected/active. |
| `🗜` | Compact session | `/compact`, compact confirmation action | Do not use for generic cleanup/delete. |
| `⏩` | Abort and advance | Busy `/next` command result and matching menu action | Means the active turn is aborted before advancing to queued work. |
| `▶️` | Play / continue immediately | Idle `/next` result, `/continue` command, and matching menu action | Means work can start or resume directly without first aborting an active turn. |
| `⏹️` | Abort current Pi work | `/abort` command description and active `/stop` result | Stops active work; accompanying copy states separately when queued work is cleared. |
| `🟥` | Destructive stop command | `/stop` command description | Strong warning at the command/action entrypoint; standalone results use the more precise idle or abort state icon. |
| `🆕` | New session / fresh start | `/new`, session replacement notices | `/new` replaces the active Pi session while preserving the current classic chat or Thread target; use it only for a real session reset. |
| `🔄` | Refresh | Queue refresh row and future refresh buttons | Re-fetch/re-render current surface, not transport reconnect. |
| `🔀` | Reroute to an existing target | Root `🔀 Reroute: send it to a Pi thread` button, the `🔀 Reroute … to:` submenu heading | Crossing arrows mean the held message branches off to another live thread; its target buttons use `🧵`. |
| `🔁` | Replace/restore mode | Root `🔁 Restore: move a Pi into this tab` button and the `🔁 Restore a Pi into this tab:` submenu heading | Same marker for the action at both levels, like `🔀` for Reroute; its target buttons use `🧵`. |
| `☑️` | Activate / choose this item | Model detail activation action, generated button-only choice heading | Positive selection cue; use `🟢 Active` for already-current state. |
| `⛔️` | Cancel source routing | `⛔️ Cancel routing` chooser action and the `Routing cancelled` toast | Not an abort of active Pi work. Private retention remains mandatory; disposable-tab removal stays bound to exact eligible target authority and follows only once every input in the tab is resolved. |
| `❌` | No / cancel / terminal failure | Confirmation cancel buttons and terminal failure notices | Do not use for a recoverable operation failure that leaves session state intact. |
| `🗑` | Delete / defer removal | Destructive confirmations and removal reaction | In the queue menu, reversible Keep/Skip selectors replace immediate deletion. |

### Informational Feedback

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `💤` | Nothing active | No-active-turn notices | Neutral idle result, not an error. |
| `✅` | Completed successfully | Compaction and other completion notices | Use only after the operation has completed. |
| `🚫` | Unavailable, denied, or cancelled operation | Missing capability/auth notices, access denial, and compaction cancellation | Callback toasts carry no emoji. |
| `⚠️` | Recoverable operation failure | Compaction failure notice | The attempted operation failed, but the original session state remains usable. |

### State Indicators And Button Grammars

| Emoji | Meaning | Canonical surfaces | Notes |
| --- | --- | --- | --- |
| `🟢` | Current/active/enabled `On` | Current option in vertical lists, active state rows, active `On` toggle | One marker per selected list value; inactive list values stay unmarked. |
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

Some emoji are intentionally local examples or decorative variants, not global semantics. Empty-queue rotating messages (`🫙`, `🍃`, `🕳`, `🦗`, `🌙`, `🧘`, `🪐`, `🧺`, `🔭`, `🫧`, `🛸`) are copy flavor only and must not become controls. The Guest Mode placeholder frames (`🌎`, `🌍`, `🌏` stepping every second with dots growing once every two seconds) are the same kind of decorative copy: they complete whole 6-frame cycles over at least a ~20 s rotation while a guest answer is pending and then hold the cycle's final frame (a 26 s safety bound caps slow streams), never become controls, and must not carry another meaning. Example extension icons such as `🧪`, `🔧`, and `🗂` are documentation fixtures for companion extensions, not built-in pi-telegram meanings.

Thread UI rule: thread lifecycle and status copy starts with `🧵`. Route choosers lead with their action instead: `🚦` asks for the routing decision at the root, the `🔀`/`🔁` submenu headings name the chosen action, and the concrete thread target buttons beneath them carry `🧵`, so the same marker always means "a thread".

## Button Control Hierarchy

All inline controls are buttons at the transport level. The local UI kit gives them three visual roles:

- **Action button:** Performs an action or navigation, using its semantic emoji and Capitalized action text.
- **List-item button:** Represents a value in a collection. Use lowercase value labels; only selected values carry a state-circle emoji, while unselected values have no emoji. A list may support single or multiple selection.
- **Radio-style button:** Represents a labelled state choice. Use Capitalized labels and an indicator on every value: a semantic colored circle for active values, `⚫️` for inactive values. A radio group normally selects one value; checkbox-like binary controls and tabs reuse this same visual family rather than introducing separate label grammars.

Selection cardinality belongs to the control's domain, not to the visual family. Independent checkbox dimensions or tab groups may each have an active value. Do not confuse list and radio-style controls merely because both can select one item. Canonical names, identifiers and numeric/spatial tokens keep their own spelling; casing rules apply to authored value words.

These are button-based visual grammars, not claims that Telegram exposes native list, radio, checkbox or tab widgets. Selection markers project actual state; they never grant callback, mutation or routing authority. The specialized rules below define each reuse.

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

Boolean settings are checkbox-like binary controls rendered with the radio-style grammar as a horizontal `On` / `Off` pair.

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

Tabs or small mutually-exclusive scopes reuse the radio-style grammar in a horizontal row.

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

## Option Lists

Option lists represent values from a collection and may allow single or multiple selection. Current model selection, thinking level, voice reply mode and time injection mode are single-choice examples.

Rules:

- Put each option on its own row when labels are long, the set may grow, or scanning benefits from full width.
- A fixed set of short, ordered peer values may use compact rows of up to three buttons.
- Keep a semantically distinct value such as thinking `off` on its own full-width row before grouped intensity values.
- Mark only selected values with the appropriate state circle (`🟢` by default); a multi-select list marks each selected value.
- Leave unselected values without emoji, never with the radio family's `⚫️` placeholder.
- Use lowercase authored value labels; preserve canonical names, identifiers and numeric/spatial tokens.

Examples:

- Vertical: `hidden`, `🟢 mirror`, `always`.
- Thinking: full-width `off`, then `minimal` / `low` / `🟢 medium`, then `high` / `xhigh` / `max`.
- Numeric page picker (list grammar, not radio-style tabs): `1` / `🟣 2` / `3`.

## Generated Prompt Buttons

A button-only assistant reply uses the standard Rich Markdown heading `☑️ **Choose an option:**`: semantic icon first, one space, bold heading text, and a final colon. Every generated human-readable action label starts with the most semantically appropriate emoji, one ASCII space, then concise action text. Emoji selection is part of authoring the control, including compact label-equals-prompt forms. Emoji-free text remains a syntax-compatible fallback only when no honest semantic marker exists after considering the action, domain, and state—not merely for convenience or label pressure; genuine coordinate and symbolic spatial controls retain their established grammar. Generated non-spatial controls default to vertical full-width buttons represented as top-level matrix cells. Nested row arrays are a compact-peer exception only when every label is unmistakably short—roughly 15 visible characters or fewer including emoji and space; this is a judgment heuristic rather than a mechanical count, and any plausible ellipsis or wrapping risk returns the controls to vertical rows. Assistant-generated prompt buttons use the default app style before selection. After queue admission, edit only the selected button to its agent-configured `selected_style`: `primary` (default/blue), `success` (green), or `danger` (red). Preserve its agent-authored text and emoji, leave other choices at their default style, and always queue the selected prompt regardless of color. The callback acknowledgement remains the compatibility fallback when a client does not render button styles.

## Navigation

Inline submenu navigation is hierarchical.

Rules:

- Put the navigation row first.
- First-level submenus opened from the main inline menu start with `⬆️ Main menu`.
- Deeper submenus start with `⬆️ Back`.
- `Main menu` returns to the root inline menu.
- Choosing a Thinking level refreshes the same chooser and its current marker without leaving the submenu; only the top `Main menu` button returns to the root.
- `Back` returns one level up, never directly to the root unless the parent is the root.

Examples:

- Main menu → Settings: first row is `⬆️ Main menu`.
- Settings → Voice reply mode: first row is `⬆️ Back`.

## Route Chooser

A message (or All-tab command) held in an unbound or temporary tab gets one route chooser.

- Root text: bold heading `🚦 Route this message:` (or `🚦 Route <code>/start</code>:` for a command), a blank line, then the italic note `The choice expires in 60 minutes.` When Reroute is the only possible action (an All-tab command without a temporary tab), the italic note says `To restore a Pi instead, send a message in a new tab.` instead.
- Root buttons, one per row and only when available: `🔀 Reroute: send it to a Pi thread`, `🔁 Restore: move a Pi into this tab`, `⛔️ Cancel routing`. The `🚦` heading echoes these three choices, with `⛔️` as the red stop.
- Submenus start with `⬆️ Back`, which restores the root with its exact original text. Headings are bold: `🔀 Reroute this message to:` / `🔀 Reroute <code>/start</code> to:` name the root's subject, and `🔁 Restore a Pi into this tab:` names a command only when there is one (`🔁 Restore a Pi into this tab for <code>/start</code>:`). Every target button below is a thread, written `🧵 <display title>`.
- Cancel appears only at the root.
- An input sent from `All` moves into the routing tab opened for it: the tab starts with a silent forward of the input (Telegram shows it as forwarded from the operator), the chooser replies to it, and the original leaves `All` once the copy is confirmed. A restored Thread therefore keeps the prompt it answers.
- A chooser is one-shot: every final outcome deletes its message. A confirmed Cancel, a Forward or Reroute, and a successful Restore remove the menu; Restore keeps the tab as the Pi's Thread, while a temporary tab with no remaining unresolved input is removed. If Telegram refuses the delete, Cancel and Restore leave an inert bold notice (`⛔️ Routing cancelled.` / `✅ Message routed.`) with an empty keyboard, and Forward asks for one more tap to clear the menu.
- Old or expired controls answer `⌛ Routing choice expired.`
- Tab name: every temporary routing tab is named `🚦 Routing`, whether the bot created it (menu command or threadless prompt) or adopted the `New Chat` tab Telegram opened for a typed input. It is never renamed after its first input.
- Status → `❌ Pending cancellations` lists one row per protected original: its text, or `📎` plus the caption, file name or the message field carrying Telegram's `file_id`.

## Pi Connection Notices

Pi TUI connection notices use plain text: a short known cause and one recovery action. Unknown failures use a generic connection-failed notice with `/telegram-status --debug`; never interpolate raw exceptions, credentials, stack traces or Pi lifecycle guidance. Technical evidence belongs in the redacted runtime recorder. Failed disconnect must retain the instruction to keep Pi open; do not also rethrow the same error as a second Pi banner. These TUI notices are distinct from Telegram bot message cards below.

The compact TUI status bar preserves the acknowledged Thread display title and its casing, including manual `/name` overrides. Names equal to `Telegram`, `Leader` or `Follower` are ordinary titles, not fallback markers. Connection states, including disconnected and error, do not replace a supplied title; only an absent or empty title uses the generic `telegram` label.

## Message Cards

Message cards and standalone informational notices sent by the bot should start with a strong heading.

Rules:

- Start with a bold heading or, for dialogs, a bold question.
- Format standalone notices as one fully bold line: relevant emoji, one space, concise sentence, and terminal period. Menu or chooser headings use the same fully bold form but end in a colon when controls or detail follow. Empty-queue headings are the deliberate exception: fully bold, with no trailing period or colon.
- List items in bot-authored messages and cards start with `<code>-</code>` and a space, the same marker rendered Markdown lists use; never `•`.
- Keep the emoji and complete sentence or heading inside the single bold span; do not bold only a fragment. A material name or phrase may receive nested italic emphasis without breaking the outer bold hierarchy—for example `<b>📡 Instance <i>Cedar</i> connected.</b>`.
- Apply the same hierarchy to success, progress, empty, busy, unavailable, cancellation, and failure notices.
- Once an action has settled, describe only the completed result in completed-state language. Do not append transitional copy such as “returning” or “starting”; use a separate progress surface only while work is genuinely still pending.
- Distinguish the two surfaces. An in-chat notice stays in the conversation (a sent message or an edited chooser/menu/card) and uses the bold, period-terminated form above. A callback toast is the client's fleeting tooltip that vanishes after a couple of seconds: concise plain text with no emoji and no terminal sentence period; question/exclamation marks and ellipses stay. Every toast follows this one form, so emoji meanings in the registry apply to messages, headings and buttons, never to toasts.
- Write every notice and toast in its final form where it is used. No delivery boundary rewrites punctuation, so text shared by both surfaces is two separate strings, each in its own form; companion `ctx.answerCallback` text likewise reaches the client exactly as written.
- Navigation answers silently: opening a submenu or going Back, in the main menu and in temporary routing tabs alike, edits the message and acknowledges the tap without a toast. The edited message is the feedback.
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
