# Outbound Handlers

`pi-telegram` maps hidden assistant-authored HTML comments to Telegram-native outbound actions.

Normal Telegram-turn replies are intentionally prompt-driven: the agent writes Markdown plus small hidden top-level blocks, and the bridge performs transport after `agent_end`. `telegram_voice` and `telegram_button` are not π tools. For local/TUI-initiated work where the user explicitly asks to send something to Telegram, the bridge also exposes direct tools: `telegram_message` for Markdown text and `telegram_attach` for file delivery when no Telegram turn is active. Direct local/TUI delivery requires this π instance to own `/telegram-connect`; if polling/control ownership moved elsewhere, the tools fail instead of bypassing the singleton lock. Outbound behavior combines assistant prompt markup, text command-template handlers, registered voice synthesis providers, generated artifacts, direct Telegram tools, and reply delivery. Direct `telegram_message` text is planned through the same reply markup path, so embedded top-level `telegram_button` comments become buttons attached to that text message.

Text handlers use the portable [Command Template Standard](./command-templates.md). Programmatic outbound handlers use `registerTelegramOutboundHandler(kind, handler)`. Voice replies can use configured command-template handlers or the provider API described in [Voice Integration](./voice.md).

## Standard

An outbound handler is selected by `type`. Text replies and assistant markup map to handler types:

| Source            | Handler                       | Action                  |
| ----------------- | ----------------------------- | ----------------------- |
| Final text        | `outboundHandlers[type=text]` | Transform before render |
| `telegram_voice`  | Voice pipeline                | OGG/Opus `sendVoice`    |
| `telegram_button` | Built-in                      | Attach inline button    |

The voice pipeline is detailed below: configured `type: "voice"` handlers first, then programmatic handlers, then registered synthesis providers.

Configured text handlers provide `template`. A string is one command; an array is ordered composition. Top-level `args` and `defaults` apply to all composed steps unless a step defines private values. The command-template default timeout applies automatically. Use `template: [...]` for composition; the old local `pipe` alias is removed in 0.13.0.

## Text Handler Config

`type: "text"` handlers transform final text replies before rendering and delivery. The source text is provided on stdin and as `{text}`. Successful non-empty stdout replaces the current text. Empty stdout or handler failure keeps the previous text and records diagnostics.

This is ideal for machine translation, tone normalization, redaction, glossary expansion, compliance footers, or any other final text rewrite that should be configured outside the agent prompt. Text handlers run before Markdown/HTML rendering, so a Markdown reply remains Markdown input to the handler. They also run when the bridge finalizes an already streamed rich preview; in that path Telegram can briefly show a pre-transform preview before the final edited message is replaced with the handler output. Inline buttons are built as reply markup: visible button labels pass through the same text handler, while callback data and callback prompts remain unchanged.

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
    const audioPath = await synthesizeToOggOpus(text, options);
    return { audioPath, transcriptText: text };
  },
  { id: "my-extension/tts" },
);
```

Synthesis providers receive the extracted `telegram_voice` text plus optional `lang`/`rate` hints. Stable registrations pass a durable `id`; omitted ids remain a compatibility path for older providers. Providers own translation, TTS, speech rewriting, transcript choice, and OGG/Opus conversion. The bridge validates that the returned file ends in `.ogg` or `.opus`, sends it through Telegram `sendVoice`, and falls back to planned text if delivery fails before any visible text was delivered. Providers run after configured and programmatic voice handlers in the priority chain above.

## Voice Markup

Assistant replies can include a hidden voice block:

```md
Full text answer stays here.

<!-- telegram_voice lang=ru rate=+30%
Text to synthesize as a Telegram voice message.
-->

<!-- telegram_voice lang=ru rate=+30% text="Short spoken companion summary." -->

<!-- telegram_voice: Short spoken companion summary. -->
```

The bridge strips the comment from Telegram text. On `agent_end`, it maps each `telegram_voice` block to a provider call, generates one file per block, and sends each file as an independent Telegram-native voice message. The opening `<!-- telegram_voice` marker must start at column zero on a top-level line outside fenced code, quotes, and lists; otherwise it is rendered as literal Markdown. Body-form comments leave the opening line unclosed until the body-ending `-->`; closed heads can use `text="..."` for explicit one-line spoken text.

## Buttons Markup

Assistant replies can include independent button blocks. The prompt is sent back to π when the user taps the button; use the colon shorthand when the prompt should equal the label, `prompt="..."` for one-line prompts, or the body form for multiline prompts:

```md
I can continue.

<!-- telegram_button label=Continue prompt="Continue with the current plan." -->

<!-- telegram_button label="Show risks"
List the main risks first.
-->

<!-- telegram_button: Done -->
```

Rules:

- `telegram_button: Label` creates one independent label-only button row whose prompt equals the label.
- `telegram_button label="Label" prompt="Prompt"` creates one independent button row whose prompt is the `prompt` attribute.
- `telegram_button label="Label"` with a body creates one independent button row whose prompt is the block body.
- The opening `<!-- telegram_button` marker must start at column zero on a top-level line outside fenced code, quotes, lists, and indented examples; otherwise it is literal Markdown.
- Keep the canonical body form as `<!-- telegram_button label="Label"` + body + `-->`; closed heads must use `prompt="..."` or the colon shorthand to create a button.
- Use one block per button; this mirrors HTML's singular element model and avoids a nested button DSL inside comments.
- Button actions are stored in memory with short `callback_data`; Telegram never sees the full prompt in the button payload.

Do not emit JSON button specs, inline comments after visible text, standalone button actions, or tool calls for ordinary Telegram-turn buttons. The agent writes Markdown plus hidden comments; the bridge strips comments and attaches Telegram `reply_markup` after `agent_end`. For local/TUI-originated direct sends, put the same Markdown and `telegram_button` comments in `telegram_message(text)`.

Buttons are built in and do not need a command template because they are pure Telegram reply markup plus callback routing.

## Prompt Contract

The extension injects Telegram-specific system prompt guidance so agents know the fast path:

- Write the full technical answer as normal Markdown.
- Add `telegram_voice` when a Telegram-native voice message is useful; use body text, `text="..."`, or colon shorthand for the text to synthesize. A companion summary is optional, no specific summary format is required.
- Add `telegram_button: ...` when label equals prompt, `telegram_button label="..." prompt="..."` for one-line prompts, or `telegram_button label="..."` with a body for multiline prompts. If the reply contains only button/voice comment blocks, add a short visible marker (for example `Choose one:`) before them so Telegram always has a visible parent message for attachment.
- For ordinary Telegram-turn replies, do not call transport tools for voice or buttons; the bridge owns delivery, while registered voice synthesis providers own TTS and OGG/Opus conversion. For explicit local/TUI direct sends, `telegram_message` may include top-level `telegram_button` comments in its Markdown text because those buttons are attached to that text message.
- Never send buttons without visible parent text. If the answer would contain only hidden comments, add a compact line such as `Choose one:` first.

This keeps the agent focused on semantics and lets the bridge handle low-latency Telegram adaptation.
