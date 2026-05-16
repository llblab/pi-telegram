# Voice Integration

Zones: telegram, pi agent, shared utils

Voice messages flow through an **inbound transcription → outbound voice reply** pipeline. This document describes the bridge's role in that pipeline; provider-specific mechanics (TTS/STT backends, voice IDs, languages) are owned by the voice provider extension.

## Overview

1. **Inbound:** A voice message arrives via Telegram. Inbound handlers transcribe it to text.
2. **Processing:** The transcription becomes the agent prompt. The bridge tags the turn if it originated from voice.
3. **Outbound:** If voice replies are enabled, the agent's text response is converted to voice and sent back. No text draft appears in Telegram during generation.

## Voice Detection

Voice messages arrive as `message.voice` in Telegram updates. The bridge's media processing detects these and sets `kind: "voice"` on the downloaded file. Regular audio files (`message.audio`) get `kind: "audio"` and do not trigger voice reply tagging.

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

## Voice Reply Policy

The bridge decides **when** to reply with voice. The policy is controlled by the `voice.replyMode` field in `TelegramConfig` (stored in `telegram.json`).

### Modes

| Mode | Behavior |
|------|----------|
| `manual` (default) | Only reply with voice when the agent authors `<!-- telegram_voice -->` markup |
| `mirror` | Reply with voice when the **inbound** message was a voice note |
| `voice` | Always reply with voice |

**Warning:** In `voice` mode, the bridge transparently intercepts ALL text replies and converts them to voice on success. Users will only receive voice messages when voice generation succeeds. If voice generation fails, the bridge falls back to sending the planned text reply.

When a voice message is received, the bridge reads `voice.replyMode` from config and tags the turn:
- `voiceReplyPreferred`: `true` when mode is `mirror` and the turn has a voice file
- `voiceReplyRequired`: `true` when mode is `voice`

At `agent_end`, if the turn is voice-tagged and the agent response has no explicit `telegram_voice` markup, the bridge transparently intercepts the text reply and converts it to voice. If the agent uses multiple `telegram_voice` blocks, each becomes a separate voice message.

### Preview Suppression

When a turn is voice-tagged, the bridge suppresses text preview streaming during LLM generation. This prevents draft text from appearing in Telegram before the voice message is delivered.

## Outbound Voice Provider Registration

Voice provider extensions (such as `pi-xai-voice`) register themselves through `registerTelegramVoiceProvider()`. The bridge only provides the registration seam and the actual delivery to Telegram. **The provider is fully responsible for**:
- Text optimisation / speech-style rewriting
- Adding speech tags (when desired)
- Running TTS + ffmpeg conversion to OGG/Opus
- Deciding whether to return `transcriptText` at all (based on the user's "Send Transcript" toggle)
- `transcriptText` (when returned) is attached by the bridge as the voice message **caption** only. Separate transcript messages are no longer sent.

The bridge shows a `record_voice` action while delivering and handles the final `sendVoice` + optional follow-up text message.

A stronger form of prompt guidance is planned for the future: providers will be able to implement `getVoicePromptContribution(view)` so the bridge can inject voice-specific instructions (e.g. "Reply ONLY with the spoken text. NO thinking..."). This hook already exists in the `TelegramVoiceProvider` interface, but the bridge does **not yet** perform the injection.

Until this is implemented, providers that want strong voice-specific LLM behavior must handle it themselves (e.g. through their own system prompts or rewriting).

See the TSDoc on `registerTelegramVoiceProvider` and `TelegramVoiceProviderResult` in `lib/outbound-handlers.ts` for the exact interface.

The provider receives the raw agent text plus optional `{ lang?, rate? }`.

It must return one of:
- `string` — path to a ready `.ogg` or `.opus` file
- `{ audioPath: string, transcriptText?: string }` — `audioPath` must be OGG/Opus. When `transcriptText` is present it is attached as the voice message **caption**. The "Send Transcript" toggle in the provider's UI controls whether you return `transcriptText` (ON = caption, OFF = no text at all). The old `sendTranscriptAsMessage` flag is deprecated and ignored.
- `undefined` — skip this text block

**Important:** The bridge never runs ffmpeg or does speech rewriting. The provider is fully responsible for producing a clean, TTS-optimised text, running TTS, and converting to native voice format.

**File format:** Telegram `sendVoice` requires **OGG/Opus** to display the message as a native voice note (waveform, inline playback). MP3 and other formats are accepted by the API but render as regular audio attachments (music note icon, filename visible). **Providers must return `.ogg` or `.opus` files.** The bridge does not run ffmpeg or any format conversion — conversion is the provider's responsibility. Returning non-OGG files causes the bridge to throw and fall back to text delivery.

Registration returns a disposer function for cleanup.

### Provider with transcript caption (controlled by user toggle)

When the user's "Send Transcript" toggle is ON, return the clean spoken text as `transcriptText`. The bridge attaches it as the caption on the voice message. When the toggle is OFF, return only the audio path (no `transcriptText`).

```typescript
registerTelegramVoiceProvider(async (text, options) => {
  const rewritten = rewriteWithSpeechTags(text);
  const audioPath = await myTTS(rewritten, { language: options?.lang });
  const sendTranscript = getUserSendTranscriptPreference(); // from your UI + telegram.json
  return sendTranscript
    ? { audioPath, transcriptText: text }
    : { audioPath };
});
```

The bridge never sends a separate transcript message. Caption-only is the "ON" behavior.

### Surfacing provider diagnostics

Voice provider extensions can record runtime events that appear in `/telegram-status` alongside pi-telegram's own events:

```typescript
import { recordTelegramRuntimeEvent } from "@llblab/pi-telegram";

recordTelegramRuntimeEvent("xai-voice", new Error("TTS failed"), {
  phase: "tts",
  text: text.slice(0, 50),
});
```

`recordTelegramRuntimeEvent` writes to the same event ring that pi-telegram uses. Events are visible via `/telegram-status` in Telegram. Calls are silently dropped if pi-telegram is not loaded.

## Voice Extension Section

Voice provider extensions can register a Voice Extension Section (settings UI) via `registerTelegramSection`. The section can expose controls for reply mode, TTS voice, language, speech style, transcript behavior, etc.

**Note on resume:** Because the previous automatic persistent re-registration system has been removed, extensions are responsible for re-registering their Voice Extension Section on `session_start` if they want the menu to survive a `pi resume`. See `registerTelegramSection` in `lib/extension-sections.ts`.

## Prompt Guidance (Planned)

The bridge appends a compact note (`[The user sent a voice message.]`) when a voice file is detected.

A stronger mechanism is planned for the future: voice providers will be able to supply their own prompt guidance via `getVoicePromptContribution(view)`. This hook is already part of the `TelegramVoiceProvider` interface, but **the bridge does not yet inject the contribution** into the agent prompt.

Until this is wired, providers that want strong voice-specific instructions currently need to handle this themselves (e.g. via system prompts or other means).

## Fallback Behavior

### If voice generation fails
1. The bridge records the failure via `recordRuntimeEvent`
2. The voice sender throws an error, which the runtime catches
3. The runtime falls back to sending the planned text reply (outbound markup stripped, `replyMarkup` preserved)

### If no voice provider is registered
- The voice sender throws because no provider can deliver the voice reply
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
    "replyMode": "manual"
  }
}
```

Valid values: `"manual"`, `"mirror"`, `"voice"`. Default is `"manual"`.

The bridge reads `voice.replyMode` from the config when building a turn.

### Provider config

Provider-specific settings (voice ID, language, speech style, transcript behavior) are owned by the voice provider extension. The bridge does not define or validate these fields. Provider extensions typically store them in `telegram.json` under their own namespace or in separate files.
