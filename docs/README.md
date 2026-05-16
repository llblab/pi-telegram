# Documentation Index

Living index of project documentation in `/docs`.

## Documents

- [architecture.md](./architecture.md) — Overview of the Telegram bridge runtime, queueing model, rendering pipeline, and interactive controls
- [command-templates.md](./command-templates.md) — Portable command-template standard core
- [inbound-handlers.md](./inbound-handlers.md) — Local `pi-telegram` inbound text/media handler bus, legacy `attachmentHandlers` compatibility, placeholders, and fallbacks
- [outbound-handlers.md](./outbound-handlers.md) — Local `pi-telegram` outbound-handler config, text/voice/button behavior, artifact outputs, and callback routing
- [voice.md](./voice.md) — Voice integration guide: detection, reply policy, handler registration, provider integration, and transparent interception
- [locks.md](./locks.md) — Shared `locks.json` standard for singleton extension ownership
- [callback-namespaces.md](./callback-namespaces.md) — Shared Telegram `callback_data` namespace standard for layered extensions
- [external-handlers.md](./external-handlers.md) — Runtime interceptor registry that lets layered extensions observe and consume Telegram updates without owning their own polling connection
- [extension-sections.md](./extension-sections.md) — Telegram Extension Sections Standard: registration contract, context ports, callback routing, navigation hierarchy, and demo reference for pi extensions that want Telegram UI surfaces
