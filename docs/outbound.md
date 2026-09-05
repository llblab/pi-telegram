# Outbound Handlers

`pi-telegram` maps hidden assistant-authored HTML comments to Telegram-native outbound actions.

Normal Telegram-turn replies are intentionally prompt-driven: the agent writes Markdown plus small hidden top-level blocks, and the bridge performs transport after `agent_end`. `telegram_voice` and `telegram_button` are not Pi tools. Action activation remains restricted to recognized top-level column-zero comments, but Telegram preview and final delivery remove every assistant-authored `<!-- … -->` block regardless of Markdown position or owning extension. Unclosed comment tails are withheld, comment-only text plans send no message, and the Pi terminal transcript remains unchanged. For local/TUI-initiated work where the user explicitly asks to send something to Telegram, the bridge also exposes direct tools: `telegram_message` for Markdown text and `telegram_attach` for file delivery when no Telegram turn is active. In classic mode, direct local/TUI delivery requires this Pi instance to own `/telegram-connect`; in Threaded Mode, a registered follower may route direct-tool sends through the leader-owned bus transport. During an active Telegram turn, `telegram_message` rejects an implicit or same-turn target so ordinary final delivery remains the sole current-target response. Its `thread` argument accepts a case-insensitive live thread name or numeric id: the bridge preflights one live owner, sends visibly, then admits the text as a source-attributed turn in that instance. Unknown, ambiguous, same-target, offline, and cross-chat destinations fail before sending. Existing `chat_id` plus `thread_id` targeting stays compatible; registered followers use authenticated, generation-fenced bus routing. Outbound behavior combines assistant prompt markup, text command-template handlers, registered voice synthesis providers, generated artifacts, direct Telegram tools, and reply delivery. Direct `telegram_message` text is planned through the same reply markup path, so embedded top-level `telegram_button` comments become buttons attached to that text message.

Text handlers use the portable [Command Template Standard](./command-templates.md). Programmatic outbound handlers use `registerTelegramOutboundHandler(kind, handler)`. Voice replies can use configured command-template handlers or the provider API described in [Voice Integration](./voice.md).

## Public Assistant Output

Every completed `assistant-segment` with `placement: "intermediate"` from a Telegram-originated turn is delivered as its own message to the immutable originating target before the ordinary active-turn final reply. Final and terminal-partial Telegram segments remain owned by active-turn settlement so the final answer, voice, buttons, previews, and artifacts are not duplicated.

While Telegram is connected, local, autonomous, and unclassified extension follow-up Pi work always projects every completed public block—including visible commentary/checkpoints and the final answer—to the instance's authorized target in source order. There is no projection setting or opt-out: disconnecting Telegram is the boundary that stops this companion surface. Both paths consume normalized complete Activity segments rather than raw token deltas, reasoning, or tool traffic.

Projected blocks use `assistant.rendering` independently of voice policy. Rich mode sends native Rich Markdown and HTML mode keeps the established HTML renderer; assistant-authored `telegram_button` comments are planned into prompt buttons before either renderer runs, while projection does not synthesize voice or attach queued files merely because Rich rendering is active. Ordered admission revalidates the exact target, profile/token transport generation, leader epoch or follower registration generation, and session generation before each send. Active-turn final delivery waits for admitted commentary inside its existing background delivery task, preserving commentary-before-final order without blocking Pi lifecycle completion. A `commit-unknown` outcome never permits replay.

## Technical Activity

`assistant.activity` defaults to `verbose` when absent and accepts four modes: `quiet`, `thinking`, `tools`, and `verbose`. Explicit stored values remain unchanged; invalid values fail closed to `quiet`. Every Pi instance reloads this shared file-backed mode at `agent-start`, so a setting changed from one thread applies to subsequent runs in the other live instances without requiring process reload. `thinking` shows only provider-exposed thinking, `tools` shows only completed executed tools, and `verbose` shows both without mixing technical UI into assistant Markdown.

- Provider-exposed thinking updates one persistent ordinary HTML message containing only a standard Telegram `<blockquote expandable>` with a bounded redacted latest-text window. Omitting a separate icon/level header saves one chat row while the disclosure's unique shape remains recognizable. Inline Markdown emphasis and code render as Telegram HTML instead of leaking raw markers. The bridge sends the message once, edits it only as thinking grows, and leaves the disclosure in chat; it never uses Rich drafts/Rich Messages. Providers that expose no thinking produce none.
- Completed executed tools use native `sendRichMessage` block objects. Each tool is one closed root details node summarized as bold `<Tool>:` plus monospaced `<status>`; snake-case root labels render as title words (`telegram_attach` → `Telegram Attach`), while each word preserves a leading two- or three-character repeated-letter prefix in uppercase (`ff_find` → `FF Find`). The native disclosure chevron identifies the row, and opening it immediately reveals the open `arguments` child plus separate closed retained `update N`, `result`, or `error` child details. Each child summary is one lowercase monospaced label—visually a quote-free outer JSON key with no icon, list marker, or heading emphasis—and contains one preformatted `json` block. Updates remain chronological, dropped-update counts appear in the first retained update summary, and arrays of object entries keep the denser `[{ ... }, { ... }]` layout. A known-safe Rich HTTP 400 rejection falls back once to the previous expandable HTML representation; ambiguous non-idempotent outcomes never replay.
- Thinking `sendMessage`/`editMessageText` disables link previews and breaks HTTP(S) auto-link recognition inside evidence. Rich tool messages set `skip_entity_detection: true`, so URL-like arguments, updates, and results remain literal code. Consecutive tools coalesce by editing one message only while target, activity, generation, ordering boundary, tool count, and serialized-size bounds still match. Assistant or thinking content closes the batch. A non-idempotent send with unknown commit state is never replayed; failed or ambiguous edits start no fallback send.

Thinking retains only a bounded latest-text window, tool updates retain only a bounded latest-entry window, and a session reset abandons queued old-generation work without making the replacement session wait for an old transport call. Final-answer delivery waits for the admitted activity queue inside the extension-owned background delivery task, so completed technical evidence cannot be overtaken by the semantic answer and Pi lifecycle completion remains non-blocking.

Technical activity is operational evidence, not part of the semantic answer stream. Final-answer rendering, voice policy, artifacts, and quiet behavior remain unchanged.

### Live Activity Smoke

Exercise one classic chat and one Threaded Mode follower target on both Telegram mobile and Desktop:

1. Leave `Activity` on `quiet`; run a thinking-capable request with two tools and confirm only normal preview/public/final output appears in established order.
2. Exercise `thinking`, `tools`, and `verbose`; confirm persistent collapsed thinking appears only in the modes that include it, two sequential tools become two independently collapsed disclosures in one message only in the modes that include tools, and the final answer follows admitted technical UI.
3. Produce oversized arguments, multiple updates, and oversized result/error output; confirm redaction/truncation markers, latest-update retention, and safe rollover to another message without flood or reordering.
4. Cancel during thinking, fail a tool, replace the Pi session, and disconnect/reconnect transport; confirm already-sent thinking remains in chat, stale activity does not cross generations, failure remains collapsed technical evidence, and subsequent work uses only the current target/authority.
5. Repeat through a registered follower and confirm every draft/send/edit stays in its assigned thread. Capture client/version, mode, target role, observed block behavior, and any Bot API/runtime diagnostic for each result.

## Standard

An outbound handler is selected by `type`. Text replies and assistant markup map to handler types:

| Source | Handler | Action |
| --- | --- | --- |
| Final text | `outboundHandlers[type=text]` | Transform before render |
| `telegram_voice` | Voice pipeline | OGG/Opus `sendVoice` |
| `telegram_button` | Built-in | Attach inline button |

The voice pipeline is detailed below: configured `type: "voice"` handlers first, then programmatic handlers, then registered synthesis providers.

### Single Rich attachment result

When `assistant.rendering` is `"rich"`, a Telegram-originated turn that queues exactly one probe-confirmed PNG/JPEG photo, MP4 video, or MP3 audio file through `telegram_attach` can combine that artifact with the final assistant Markdown in one multipart `sendRichMessage` result. The bridge normalizes the Markdown, adds one `tg://photo`, `tg://video`, or `tg://audio` reference, preserves the triggering-message reply anchor and assigned thread, carries assistant-authored inline buttons, and records the returned message id under the exact local/follower ownership scope.

The optimization is deliberately narrow. HTML rendering, empty final text, multiple files, documents and other unsupported formats, Guest Mode, explicit `telegram_voice`, voice-preferred turns, and OGG/Opus artifacts retain their established text/attachment/voice paths. A known-safe Rich upload rejection falls back to those paths. A `commit-unknown` transport outcome or a nominally successful upload without a verifiable message id never falls back or replays because the first non-idempotent send may already have committed.

This behavior does not generate media or alter voice policy. `telegram_attach` still represents an explicit assistant artifact decision, while `hidden`, `mirror`, and `always` continue to decide voice synthesis independently.

Core assistant output accepts only the Markdown or HTML `InputRichMessage` forms. Activity thinking remains persistent ordinary HTML with an expandable blockquote, while completed tool evidence uses structured `InputRichMessage.blocks` with closed details and JSON pre blocks. Thinking consumes only lifecycle content actually exposed by the active provider and never synthesizes unavailable private thinking.

### Guest Mode media boundary

A Guest Mode reply is one `answerGuestQuery` call carrying exactly one `InlineQueryResult`; it is not a normal chat target and cannot receive `sendDocument`/`sendVoice` multipart uploads through sentinel `chatId: 0`. `telegram_attach` therefore admits at most one file during a guest turn and rejects additional files before queue mutation.

Telegram accepts public URLs or existing Telegram `file_id` values for inline media results, but pi-telegram does not publish local artifacts to external hosting. A local guest document, photo, MP3 audio, or OGG/OPUS voice therefore uses a temporary upload to the paired owner's bot chat, extraction of the returned `file_id`, one cached-media guest answer, and best-effort deletion of the staging message. That message can briefly appear or notify the owner. One guest query can carry only one media item, and its answer text must fit the media caption limit rather than a separate full Rich Markdown message.

Configured text handlers provide `template`. A string is one command; an array is ordered composition. Top-level `args` and `defaults` apply to all composed steps unless a step defines private values. The command-template default timeout applies automatically. Use `template: [...]` for composition; the old local `pipe` alias is removed in 0.13.0.

## Text Handler Config

`type: "text"` handlers transform final text replies before native Rich Markdown delivery. The source text is provided on stdin and as `{text}`. Successful non-empty stdout replaces the current text. Empty stdout or handler failure keeps the previous text and records diagnostics.

This is ideal for machine translation, tone normalization, redaction, glossary expansion, compliance footers, or any other final text rewrite that should be configured outside the agent prompt. Text handlers run before native Rich Markdown delivery, so a Markdown reply remains Markdown input to the handler. They also run when the bridge finalizes an already streamed rich preview; in that path Telegram can briefly show a pre-transform preview before the final Rich Message reply replaces it. Inline buttons are built as reply markup: visible button labels pass through the same text handler, while callback data and callback prompts remain unchanged.

Simple machine-translation handler with explicit text placeholder:

```json
{
  "outboundHandlers": [
    {
      "type": "text",
      "template": "/path/to/translate --lang {lang=ru} --text \"{text}\""
    }
  ]
}
```

Stdin-based or subagent-backed translation can omit `{text}` from the template because the bridge also provides the source reply on stdin:

```json
{
  "outboundHandlers": [
    {
      "type": "text",
      "template": "/path/to/translate-stdin --lang {lang=ru}"
    }
  ]
}
```

A text handler should preserve the full message unless shortening is intentional; for translation prompts, explicitly ask the tool to keep Markdown, line breaks, and details unchanged.

## Voice Delivery Priority

Voice replies use one fallback pipeline:

1. configured `outboundHandlers` with `type: "voice"` in `telegram.json` order
2. programmatic `registerTelegramOutboundHandler("voice", ...)` handlers
3. registered voice synthesis providers from `@llblab/pi-telegram/voice`

This makes provider extensions a zero-config convenience without overriding explicit operator-owned `telegram.json` handlers. If several synthesis providers are registered, they are tried in registration order; the first provider that returns a valid `.ogg`/`.opus` artifact handles the reply. Returning `undefined` passes to the next provider, while thrown errors or invalid files are recorded before the next fallback is tried.

## Voice Synthesis Provider API

Voice replies can be delivered by synthesis providers registered through `@llblab/pi-telegram/voice`:

```ts
import { registerTelegramVoiceSynthesisProvider } from "@llblab/pi-telegram/voice";

const dispose = registerTelegramVoiceSynthesisProvider(
  async (text, options) => {
    return await synthesizeToOggOpus(text, options);
  },
  { id: "my-extension/tts" },
);
```

Synthesis providers receive the extracted `telegram_voice` text plus optional `lang`/`rate` hints. Stable registrations pass a durable `id`; omitted ids remain a compatibility path for older providers. Providers own translation, TTS, speech rewriting, and OGG/Opus conversion. The bridge validates that the returned file ends in `.ogg` or `.opus`, sends it through Telegram `sendVoice`, and falls back to planned text if delivery fails before any visible text was delivered. Providers run after configured and programmatic voice handlers in the priority chain above.

## Voice Markup

Assistant replies can include hidden voice actions as a positional compact cell or JSON object:

```md
Full text answer stays here.

<!-- telegram_voice {Short spoken companion summary.|ru|+30%} -->

<!-- telegram_voice {"text":"First line.\nSecond line.","lang":"ru"} -->
```

The bridge strips the comment from Telegram text. On `agent_end`, it maps each `telegram_voice` action to a provider call, generates one file per action, and sends each file as an independent Telegram-native voice message. Prefer `{text}`, `{text|lang}`, or `{text|lang|rate}`. Use JSON when multiline content, named fields, or escaping earns the extra syntax; equivalent JSON `text` or `value` supplies the spoken payload, with explicit `text` taking precedence. Each comment creates one voice artifact, so voice cells do not accept button-style matrix composition. The opening marker must start at column zero on a top-level line outside fenced code, quotes, lists, and indented examples; otherwise it does not activate a voice action and is still removed from the Telegram surface.

## Buttons Markup

Assistant replies can include one or many button actions through a top-level `telegram_button` comment:

```md
I can continue.

<!-- telegram_button [{⬆️ Up|/}[{⬅️|page-1}{➡️|page-3}]{📁 etc|/etc}] -->

<!-- telegram_button {"label":"▶️ Continue","prompt":"Continue with the current plan.","selected_style":"primary"} -->
```

Rules:

- The payload may be a JSON object, adaptive JSON/CML matrix, or positional [Compact Matrix Literal](./compact-matrix-literal.md). Named JSON objects and positional cells may coexist in one matrix or row. Commas are optional between completed elements, and one trailing comma before a closing delimiter is tolerated; JSON object validation likewise tolerates trailing commas but does not invent missing values, property names, or internal separators. CML uses `{value}`, `{label|prompt}`, `{|prompt}`, or the corresponding three-atom form with `selected_style`; the optional third atom requires a non-empty prompt and accepts only `primary`, `success`, or `danger`. A fourth atom accepts `1` or `true` (disabled), and `0` or `false` (enabled), with exact lowercase spelling, permitting an empty style atom in this form: `{|Next||1}`. An omitted fourth position stays enabled. JSON uses boolean `disabled`; legacy attributes accept `disabled="true"` or `disabled="false"`. Invalid disabled values reject the candidate matrix atomically. Disabled cells require no prompt or selected style: `{Next|||1}` is label-only and `{|||1}` is blank, equivalent to JSON `{"label":"Next","disabled":true}` and `{"disabled":true}`. They retain their row and label, serialize as `{ text, disabled: {} }` (non-breaking-space text for a blank cell), and register no callback, prompt, or bound app action. It trims every atom, preserves non-structural printable text, and decodes only `\|`, `\}`, and `\\`.
- Use `label` plus `prompt`, or the compact `value` key when both strings are identical. If only `label`, only `prompt`, one-field `{value}`, or prompt-only `{|prompt}` is present, that string supplies both visible label and queued prompt. An explicit counterpart takes precedence over `value`. Use JSON with `\n` escapes for multiline prompts.
- The opening marker must start at column zero on a top-level line outside fenced code, quotes, lists, and indented examples; otherwise it does not activate a button action and is still removed from the Telegram surface.
- Prefer one matrix comment for multiple buttons. Each top-level JSON object or CML cell becomes one full-width inline-keyboard row in source order; a nested row groups one or more buttons horizontally. The parser imposes no artificial per-row width cap; empty rows, malformed cells, unknown/trailing CML escapes, a fourth unescaped CML separator, empty enabled-cell prompts or three-atom styles, invalid disabled flags, empty one-atom cells, unknown selected styles, and deeper nesting are rejected atomically. Multi-atom cells may omit the label; four-atom cells may additionally omit the selected style, and disabled cells may omit the prompt. Generated surfaces default to five columns and expand to six through eight only for short position-bearing labels. Repeated singular comments remain valid.
- Button actions are stored in memory with short `callback_data`; Telegram never sees the full prompt in the button payload.
- Standalone column-zero fences opened by exactly three backticks and `telegram_button` use the same singleton/matrix JSON/CML grammar. Complete valid blocks become native `<tg-button-row>` elements in `InputRichMessage.markdown`, at their original positions. Each row supports at most eight buttons and must fit a Rich Message chunk; validation precedes callback registration for the entire block. Labels are escaped, prompts never enter the native markup, and disabled cells have no callback. Missing closures, trailing payload garbage, and invalid blocks produce no controls. Other language names and enclosing code examples stay literal. Draft previews withhold complete and unfinished action fences without registering actions. HTML compatibility projects fenced rows into the bottom keyboard before comment-authored footer rows; source ordering within each group is retained.
- In-body controls share prompt/app dispatch, TTL, generation/revision checks, and sent-message target ownership with footer controls. Their acknowledgement is the selection feedback; `selected_style` does not recolor the Rich body. No callback-triggered body rewrite is introduced, preventing a stale click from overwriting newer app output. The operator confirmed the post-reload current-client smoke: singleton CML and mixed JSON/CML in-body rows, their ordinary prompt callbacks, a labeled disabled control, and the separate footer callback work as intended. Client type was not recorded. The operator also confirmed that HTML mode projects the in-body groups into the bottom keyboard as intended. Second-client coverage, follower routing, blank cells, and app-method dispatch/revision rejection remain live-gated. Bot API evidence: `InputRichBlockButtons` / Rich Markdown `tg-button-row` and `RichMessageButton` use ordinary `callback_data` and support disabled controls.
- After Telegram accepts a generated footer button callback as a queued prompt, the bridge changes that exact button to its configured selection style without changing agent-authored text or emoji. Set `selected_style` to `primary` (blue), `success` (green), or `danger` (red); omitted or invalid values fall back to `primary`. The style never suppresses queue admission. Other choices stay visually unchanged and remain available; the callback acknowledgement remains the fallback on clients that do not render button styles.
- When generated button markup is the entire assistant reply, the bridge supplies the standard `☑️ **Choose an option:**` heading as visible message text so Telegram has a message to which it can attach the inline keyboard.

Do not emit inline comments after visible text, standalone button actions, or tool calls for ordinary Telegram-turn buttons. The agent writes Markdown plus hidden comments; the bridge strips comments and attaches Telegram `reply_markup` after `agent_end`. For local/TUI-originated direct sends, put the same Markdown and `telegram_button` comments in `telegram_message(text)`.

Buttons are built in and do not need a command template because they are pure Telegram reply markup plus callback routing.

## Prompt Contract

The extension injects prompt guidance by context:

- If no bot token is configured, no Telegram bridge suffix is injected.
- For ordinary local/TUI prompts, the compact routing note points to the bundled `telegram-bridge` Skill and forbids Telegram use unless explicitly requested.
- For Telegram-originated turns, the compact note routes the agent to `telegram-bridge`, which owns voice/button/direct-delivery/Threaded Mode/formatting/debug guidance.
- For Telegram-originated turns, write the full technical answer as normal Markdown.
- Add `telegram_voice` with positional CML by default or JSON when multiline content, named fields, or escaping requires it. A companion summary is optional, no specific summary format is required.
- Add `telegram_button` with a JSON object, JSON matrix, or positional CML. Use a hidden comment for footer placement or a standalone triple-backtick `telegram_button` block for placement between paragraphs. Prefer one matrix for multiple controls. Use `label` plus `prompt`, or `value` when they are identical; `selected_style` and boolean `disabled` are optional. Keep at least one useful enabled action on an interactive surface. A button-only reply may omit parent text because the bridge supplies `☑️ **Choose an option:**` automatically.
- For ordinary Telegram-turn replies, do not call transport tools for voice or buttons; the bridge owns delivery, while registered voice synthesis providers own TTS and OGG/Opus conversion. For explicit local/TUI direct sends, `telegram_message` may include top-level `telegram_button` comments in its Markdown text because those buttons are attached to that text message.
- Prefer meaningful visible parent text when it adds context; for a button-only answer, rely on the bridge's automatic `☑️ **Choose an option:**` fallback rather than manufacturing duplicate text.

This keeps the agent focused on semantics, prevents Telegram action syntax from leaking into normal local replies, and lets the bridge handle low-latency Telegram adaptation.
