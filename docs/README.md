# Documentation Index

Living index of project documentation in `/docs`.

`public-api.md` is the canonical entrypoint for stable extension surfaces. Focused documents exist only when a surface has enough runtime rules to need a dedicated standard.

## Documents

- [architecture.md](./architecture.md) — Overview of the Telegram bridge runtime, optional profile isolation, queueing model, native Rich Markdown delivery, UI/compat rendering, and interactive controls
- [public-api.md](./public-api.md) — Stable public API map: package entrypoints, commands, config, assistant markup, extension APIs, smoke examples, and compatibility boundaries
- [delivery.md](./delivery.md) — Target-aware companion delivery contract for operational views, logical message handles, target scopes, lifecycle fencing, and leader/follower transport
- [activity.md](./activity.md) — Normalized Pi lifecycle API for extension-owned reasoning, intermediate prose, tool activity, source identity, delivery contexts, and consumer policy examples
- [../.agents/skills/telegram-bot/SKILL.md](../.agents/skills/telegram-bot/SKILL.md) — Agent-facing Telegram Bot API lookup skill backed by a local full Bot API reference
- [../.agents/skills/domain-dag/SKILL.md](../.agents/skills/domain-dag/SKILL.md) — Project-local Domain DAG architecture skill and validator guidance
- [command-templates.md](./command-templates.md) — Portable command-template standard core
- [inbound.md](./inbound.md) — Local `pi-telegram` inbound text/media handler bus, programmatic inbound handlers, registered STT provider fallbacks, legacy `attachmentHandlers` compatibility, placeholders, and fallbacks
- [outbound.md](./outbound.md) — Local `pi-telegram` outbound-handler config, text/voice/button behavior, single-artifact Rich results, voice synthesis provider fallback priority, artifact outputs, and callback routing
- [callback-namespaces.md](./callback-namespaces.md) — Shared Telegram `callback_data` namespace standard for layered extensions
- [updates.md](./updates.md) — Update classification and runtime handler registry that lets layered extensions observe and consume Telegram updates without owning their own polling connection
- [multi-instance-bus.md](./multi-instance-bus.md) — Optional multi-instance Telegram bus architecture: profile-scoped transport, leader/follower routing, thread targets, instance slots, manual follower registration, and recovery semantics
- [sections.md](./sections.md) — Telegram Extension Sections Standard: registration contract, context ports, callback routing, navigation hierarchy, and demo reference for pi extensions that want Telegram UI surfaces
- [voice.md](./voice.md) — Voice integration guide: detection, reply policy, STT/TTS provider registration, provider-owned conversion, and transparent interception
- [ui-style.md](./ui-style.md) — Inline UI style guide for buttons, toggles, tabs, option lists, cards, and dialogs
