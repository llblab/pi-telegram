# Direct Delivery And Threads

Read this reference for explicit delivery, Thread routing, or structured selection markup.

## Selection Markup

Use `telegram_confirm` or `telegram_choice` as a strict JSON Markdown fence or HTML-comment marker, not an agent tool. Confirm accepts a JSON question string or an object with `question`; optional `confirmLabel,cancelLabel,confirmStyle,id,timeoutMs`. Choice requires `question,choices`; prefer an array of plain string labels, JSON cells/rows, or a JSON string containing CML, such as `[[{JSON|json}{CSV|csv}]]`. Cells use `label,value,style,disabled`; style is post-click feedback only.

Final output renders bold question text and neutral footer controls. A completed single-question click sends bare JSON containing only question and the visible answer label. Do not add IDs, type/version/status or selection-tag wrappers to model context. A scalar Confirm/Choice closes all alternative branches after the first selection; separate questions and ordinary prompt peers stay independent. It does not resume a tool or execute a cell value. Wizard/multiselect must accumulate through supported runtime collection; never imitate them by generating independent intermediate model prompts. Never wait on or inspect SDK handles for agent choices. SDK APIs for companion extensions remain a separate contract.

### Choose The Smallest Interaction

- Use ordinary `telegram_button` controls for independent follow-up requests/actions.
- Use a single Choice for one answer: `{"question":"Format?","choices":["PDF","HTML"]}`.
- Use `select:N` for exactly N options: `{"question":"Pick two sections","choices":["Charts","Tables","Notes"],"select":2}`. Taps toggle locally, show checkmarks/count, and create no model turns. The Nth selection completes automatically; the final answer is an array of visible labels in declared order. Cancel returns the cancel label, not a partial selection. There is no Submit/review phase.
- Use a Choice question array for a fixed wizard only when no intermediate answer needs model reasoning. For example: `[{"question":"Format?","choices":["PDF","HTML"]},{"question":"Pick two sections","choices":["Charts","Tables","Notes"],"select":2}]`. Runtime shows one question at a time, advances locally, and sends one final ordered array of question/answer pairs. An array of one question still returns an array. Do not imitate a wizard with independent buttons or new tools.
- Keep each final view within 60 active callbacks, counting cancel controls and the widest future wizard step; disabled cells cost no callback slot. Ordinary prompt/app-bound buttons share this budget, while system menus have a separate 60-message budget. Capacity may retire old groups, so never treat a stale keyboard as a waiting execution grant.
- Keep the wizard and surrounding content short enough for one message. Its earliest declared timeout bounds the whole sequence and never renews; the default is one hour. Cancel ends it with completed answers plus the current question/cancel label; unseen questions and uncompleted option sets are omitted. Expiry/lost authority does not generate an unsolicited model result.
- Keep use-case policy in this Skill, not a growing runtime business API. If the next question needs reasoning, return to the model instead of predeclaring a wizard.

As with `telegram_button`, HTML comments are active even inside code; escape `<!--` as `&lt;!--` for a literal example. Enclosing Markdown fences keep inner fences literal. Text/file request markup, task controllers and artifact-sending blocks are not implemented; keep ordinary file delivery on `telegram_attach`.

## Direct Delivery

Use `telegram_message` only when the user explicitly requests Telegram delivery from local/TUI or names a concrete different Telegram target.

- Omitted target selects the paired/default target only outside an active Telegram turn.
- `chat_id` plus optional `thread_id` selects an explicit Bot API target. A public `@username`, or an exact negative numeric channel ID with `channel: true`, uses `chat_id` without `thread_id`; channel delivery requires the direct leader, and Telegram enforces the bot's posting permission.
- `thread` selects another live Pi Thread by case-insensitive name or numeric id and admits one attributed turn there.
- During an active Telegram turn, answer the current target normally; direct delivery to that same target is rejected.
- Direct delivery requires this Pi instance to own transport or hold a live Threaded Mode registration.
- Unknown, ambiguous, same, offline, unauthorized, or cross-chat targets fail closed.

Use `telegram_attach` outside Telegram turns only for an explicit file-delivery request. Registered followers default to their assigned Thread; explicit targets must preserve both `chat_id` and `thread_id`.

## Threaded Mode

Threaded Mode uses one leader transport and visible operator-started follower Pi processes.

- `Thread` is the product term; reserve `topic` for Bot API primitives.
- A Thread follows its assigned live Pi instance and current session.
- The `All` surface controls routing; it does not create processes.
- Never invent hidden followers, launch shadow Pi processes, expose internal bus roles as user identity, or rename Threads through guessed prompts or unsupported tools.

Cross-Thread delivery must preserve the concrete target and current registration authority. Keep the source turn on its ordinary reply path and use `telegram_message(thread=...)` only for an explicitly requested different live Thread.
