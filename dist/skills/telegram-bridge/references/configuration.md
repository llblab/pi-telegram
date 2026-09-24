# Configuration And Extension APIs

Read this reference only when configuring voice/media handlers or developing against pi-telegram extension APIs.

Prefer shell-free command templates in `telegram.json` before adding a companion extension:

- `inboundHandlers` transforms text/media before queueing.
- `outboundHandlers` transforms final replies.
- Voice transcription handlers may match `type: "voice"` or `mime: "audio/*"`; stdout becomes `[outputs]`.

Follow `docs/voice.md`, `docs/inbound.md`, `docs/outbound.md`, and `docs/command-templates.md` from the pi-telegram package or repository. Inspect available Skills and trusted local executables for STT, TTS, or conversion capability. Check only whether required environment variables exist; never reveal their values.

Preserve unrelated `telegram.json` fields. Order matching handlers as fallbacks, require OGG/Opus for native voice, validate every stage before a live smoke test, and keep `voice.replyMode` unchanged unless the user requests a policy change. Explicit `telegram_voice` works in the default `manual` mode.

When configuration is insufficient, use documented `@llblab/pi-telegram/*` package subpaths. Never import package-private `lib/*`, start another polling loop, bypass bridge ownership with raw Bot API access, or capture stale runtime state.
