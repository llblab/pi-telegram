# Voice Integration

Voice messages flow through an **inbound transcription → outbound voice reply** pipeline. This document describes the bridge's role in that pipeline; provider-specific mechanics (TTS/STT backends, voice IDs, languages) are owned by voice provider extensions. This is a first-class extension surface: one companion extension can provide STT fallbacks for inbound voice/audio files and TTS fallbacks for outbound Telegram voice replies without owning a second bot polling loop.

## Overview

1. **Inbound:** A voice message arrives via Telegram. Inbound handlers transcribe it to text.
2. **Processing:** The transcription becomes the agent prompt. The bridge tags the turn if it originated from voice.
3. **Outbound:** If voice replies are enabled, the agent's text response is converted to voice and sent back. No text draft appears in Telegram during generation.

The bridge owns Telegram transport, queue integration, reply-mode policy, preview suppression, fallback text delivery, and Settings UI. Provider extensions own STT/TTS calls, speech rewriting, provider-specific menus, transcript preference, and OGG/Opus conversion.

## Voice Detection

Voice messages arrive as `message.voice` in Telegram updates. The bridge's media processing detects these and sets `kind: "voice"` on the downloaded file. Regular audio files (`message.audio`) get `kind: "audio"`; `mirror` mode treats both voice notes and audio uploads as voice input for reply-policy tagging.

Inbound handlers match `kind: "voice"` or `mime: "audio/*"` to run a transcription command:

```json
{
  "inboundHandlers": [
    {
      "mime": "audio/*",
      "template": ["/path/to/stt", "--file={file}", "--mime={mime}"]
    }
  ]
}
```

The transcription output becomes the raw text of the prompt.

Voice provider extensions can also register STT backends with `registerTelegramVoiceTranscriptionProvider()` from `@llblab/pi-telegram/voice`. Inbound command-template handlers and programmatic inbound handlers remain the stronger generic paths and run first; if no matching handler produces output for a voice/audio file, registered transcription providers are tried as fallback in registration order. The first provider that returns non-empty text wins; providers that return `undefined` pass to the next provider, and provider failures are recorded before trying the next provider. This lets a full voice extension provide both TTS and STT without requiring `telegram.json` handler templates, while still preserving operator-configured inbound handlers as the stronger choice.

## Voice Reply Policy

The bridge decides **when** to reply with voice from `voice.replyMode` in `TelegramConfig` (stored in `telegram.json`). Missing, invalid, `hidden`, and legacy `manual` values resolve to the silent `hidden` default.

### Modes

- **`hidden` (default):** no `voice.replyMode` is stored and no automatic voice context is added; explicit agent-authored `telegram_voice` actions still work.
- **`mirror`:** voice/audio input activates automatic voice delivery. Text input follows `hidden` behavior.
- **`always`:** every Telegram turn activates automatic voice delivery.

**Warning:** In `always` mode, the bridge transparently intercepts ALL text replies and converts them to voice on success. Users will only receive voice messages when voice generation succeeds. If voice generation fails, the bridge falls back to sending the planned text reply.

When a message is received, the bridge resolves the active voice reply mode and tags the turn:

- `voiceReplyPreferred`: `true` when mode is `mirror` and the turn has a voice file
- `voiceReplyRequired`: `true` when mode is `always`

At `agent_end`, if the turn is voice-tagged and the agent response has no explicit `telegram_voice` markup, the bridge transparently intercepts the text reply and converts it to voice. If the agent uses multiple `telegram_voice` blocks, each becomes a separate voice message. The same reply-mode decision applies to both registered voice synthesis providers and configured outbound voice handlers.

### Preview Suppression

When a turn is voice-tagged, the bridge suppresses text preview streaming during LLM generation. This prevents draft text from appearing in Telegram before the voice message is delivered.

## Voice Provider Extension Surface

A voice extension may combine three public seams:

- `registerTelegramVoiceTranscriptionProvider()` for inbound STT fallback on voice/audio files
- `registerTelegramVoiceSynthesisProvider()` for outbound TTS/synthesis fallback to Telegram voice messages
- `registerTelegramSection()` for provider-specific Telegram UI such as voice, language, style, transcript, or provider on/off controls

The reply policy itself remains a built-in pi-telegram setting (`voice.replyMode`) rather than a provider-owned menu.

## Outbound Voice Synthesis Provider Registration

Voice synthesis provider extensions register themselves through `registerTelegramVoiceSynthesisProvider()`. The bridge only provides the registration seam and the actual delivery to Telegram. **The provider is fully responsible for**:

- Text optimisation / speech-style rewriting
- Adding speech tags (when desired)
- Running TTS + ffmpeg conversion to OGG/Opus
- Deciding whether to return `transcriptText` at all based on the bridge-owned `voice.sendTranscript` preference when the provider has access to the current Telegram config
- `transcriptText` (when returned) is attached by the bridge as the voice message **caption** only. Separate transcript messages are no longer sent.

The bridge shows a `record_voice` action while delivering and sends the final audio with Telegram `sendVoice`. When a provider returns `transcriptText`, the bridge attaches it as the voice caption.

Providers can implement `getVoicePromptContribution(view)` to inject voice-specific instructions into voice-tagged prompts (for example: "Reply only with the spoken text"). The bridge appends the first non-empty provider contribution when `mirror` or `always` mode tags the turn.

Import provider APIs from `@llblab/pi-telegram/voice`; see the TSDoc on `registerTelegramVoiceSynthesisProvider` and `TelegramVoiceSynthesisProviderResult` there for the exact interface.

The provider receives the raw agent text plus optional `{ lang?, rate? }`.

It must return one of:

- `string` — path to a ready `.ogg` or `.opus` file
- `{ audioPath: string, transcriptText?: string }` — `audioPath` must be OGG/Opus. When `transcriptText` is present it is attached as the voice message **caption**. Providers should treat pi-telegram's `voice.sendTranscript` as the bridge-owned transcript preference instead of inventing a second reply-policy UI.
- `undefined` — skip this text block

**Important:** Providers are fully responsible for producing a clean, TTS-optimised native voice file. The bridge may also run configured outbound voice command templates for users who prefer process-boundary handlers instead of provider extensions.

**File format:** Telegram `sendVoice` requires **OGG/Opus** to display the message as a native voice note (waveform, inline playback). MP3 and other formats are accepted by the API but render as regular audio attachments (music note icon, filename visible). **Providers and outbound voice handlers must return `.ogg` or `.opus` files.** Returning non-OGG files causes the bridge to throw and fall back to text delivery.

Registration returns a disposer function for cleanup. Stable provider registrations pass a durable `id` in options; omitted ids remain a compatibility path for older providers and receive generated session-local ids. Extensions should call disposers on shutdown or re-register safely on session start when their runtime is recreated.

## Outbound Voice Handlers

Users can also configure `outboundHandlers` with `type: "voice"` in `telegram.json`. This is the command-template path for TTS without a provider extension. Reply modes (`hidden`, `mirror`, `always`) affect these handlers the same way they affect providers: explicit `telegram_voice` blocks and automatic mirror/always interception both produce a voice reply plan, then delivery tries configured outbound voice handlers first and registered synthesis providers as progressive fallbacks.

Voice handlers receive the text on stdin in composed pipelines and can use `{text}`, `{lang}`, `{rate}`, `{mp3}`, and `{ogg}` placeholders. Set `output` to `"ogg"` or another placeholder name when the template writes to a known path:

```json
{
  "voice": { "replyMode": "mirror" },
  "outboundHandlers": [
    {
      "type": "voice",
      "template": [
        "/path/to/tts --write-media {mp3}",
        "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 16000 -ac 1 {ogg}"
      ],
      "output": "ogg"
    }
  ]
}
```

Priority for outbound voice delivery is: configured `outboundHandlers` with `type: "voice"` in their `telegram.json` order, then programmatic `voice` outbound handlers, then registered voice synthesis providers. Provider extensions are the zero-config tail of the same pipeline: they handle voice when no explicit configured handler succeeds, but they do not override operator-configured handlers. If multiple providers are registered, only one handles a given voice reply: the first provider that returns a valid `.ogg`/`.opus` artifact wins. Providers that return `undefined` explicitly pass to the next provider; providers that throw or return invalid output are recorded and the next fallback is tried.

### Provider with transcript caption (controlled by user toggle)

When the user's "Send Transcript" toggle is ON, return the clean spoken text as `transcriptText`. The bridge attaches it as the caption on the voice message. When the toggle is OFF, return only the audio path (no `transcriptText`).

```typescript
import {
  getTelegramVoiceSendTranscript,
  registerTelegramVoiceSynthesisProvider,
} from "@llblab/pi-telegram/voice";

registerTelegramVoiceSynthesisProvider(
  async (text, options) => {
    const rewritten = rewriteWithSpeechTags(text);
    const audioPath = await myTTS(rewritten, { language: options?.lang });
    const sendTranscript = getTelegramVoiceSendTranscript(
      getCurrentTelegramConfigView(),
    );
    return sendTranscript ? { audioPath, transcriptText: text } : { audioPath };
  },
  { id: "my-voice-provider/tts" },
);
```

`getCurrentTelegramConfigView()` represents whatever current `TelegramConfig` view your extension already owns or receives; pi-telegram does not require providers to read config directly. The bridge never sends a separate transcript message. Caption-only is the "ON" behavior.

### Surfacing provider diagnostics

Voice provider extensions can record runtime events that appear in `/telegram-status` alongside pi-telegram's own events:

```typescript
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram/outbound";

recordTelegramRuntimeEvent("voice-provider", new Error("TTS failed"), {
  phase: "tts",
  text: text.slice(0, 50),
});
```

`recordTelegramRuntimeEvent` writes to the same event ring that pi-telegram uses. Events are visible via `/telegram-status` in Telegram. Calls are silently dropped if pi-telegram is not loaded.

## Voice Extension Section

Voice provider extensions can register a Voice Extension Section (settings UI) via `registerTelegramSection`. The section can expose provider-specific controls such as TTS voice, language, speech style, transcript behavior, or STT/TTS enablement. Reply mode is a core pi-telegram setting and belongs in the built-in Settings menu.

**Note on resume:** Because the previous automatic persistent re-registration system has been removed, extensions are responsible for re-registering their Voice Extension Section on `session_start` if they want the menu to survive a `pi resume`. See `registerTelegramSection` from `@llblab/pi-telegram/sections`.

## Prompt Guidance

The bridge keeps voice prompt context compact, effective, and policy-owned. `hidden` and text-originated `mirror` turns add no voice line. Voice/audio-originated `mirror` turns and every `always` turn add exactly `[voice] delivery: automatic voice`, describing the current delivery environment without exposing the underlying mode matrix or an instruction list. The marker is appended after `[outputs]` when handler output exists, otherwise after `[attachments]`. Voice inputs also appear in `[attachments]` with their downloaded file names, MIME data, and handler output, so agents can infer concrete voice-file context from attachment metadata.

Voice synthesis providers can supply prompt guidance through `getVoicePromptContribution(view)`, but provider text should stay optional and provider-specific. Reply-mode context belongs to pi-telegram.

## Fallback Behavior

### If voice generation fails

1. The bridge records the failure via `recordRuntimeEvent`
2. The voice sender throws an error, which the runtime catches
3. The runtime falls back to sending the planned text reply (outbound markup stripped, `replyMarkup` preserved)

### If no voice synthesis provider is registered

- The voice sender throws because no configured handler or synthesis provider can deliver the voice reply
- The runtime catches the error and falls back to text delivery

### If the provider returns a non-OGG file

- `ensureTelegramVoiceFileFormat` rejects the file (only `.ogg` and `.opus` are accepted)
- The voice sender throws and the runtime falls back to text delivery
- The provider should handle format conversion internally before returning the path

## Telegram Voice Limits

- **Duration:** Up to ~60 minutes per voice message
- **File size:** Up to 20 MB for voice uploads via `sendVoice`
- **Format:** OGG Opus is native; MP3 and other formats render as regular audio attachments
- **Splitting:** The bridge does not split long responses into multiple voice messages. Chunking is the provider's responsibility

## Configuration

### Bridge config (`telegram.json`)

```json
{
  "voice": {
    "replyMode": "mirror"
  }
}
```

Valid modes are `"hidden"`, `"mirror"`, and `"always"`; selecting `hidden` removes the key. Missing, invalid, and legacy `"manual"` values resolve to `hidden` and stay silent in prompt context.

The bridge reads `voice.replyMode` from the config when building a turn.

### Provider config

Provider-specific settings (voice ID, language, speech style, transcript behavior, STT/TTS enablement) are owned by the voice provider extension. Reply mode is owned by pi-telegram's `voice.replyMode` and configured from the built-in pi-telegram Settings menu, not duplicated in provider UIs.
