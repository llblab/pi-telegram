# Public API

`pi-telegram` is both a π extension and a small Telegram platform for companion extensions. This document defines the stable public surface. Everything outside this document is implementation detail unless another focused doc explicitly marks it stable.

## Stability Levels

- **Stable:** documented here and covered by compatibility expectations.
- **Advanced stable:** public for extension authors, but lower-level; prefer higher-level APIs when possible.
- **Compatibility:** older import/config paths that remain supported but should not be used for new code.
- **Internal:** exported from source for tests or domain reuse, but not a compatibility promise.

## Package Entrypoints

Preferred public imports:

```ts
import telegram from "@llblab/pi-telegram";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";
import { registerTelegramStatusLineProvider } from "@llblab/pi-telegram/status";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";
import { registerTelegramCommand } from "@llblab/pi-telegram/commands";
import { registerTelegramInboundHandler } from "@llblab/pi-telegram/inbound";
import { registerTelegramOutboundHandler } from "@llblab/pi-telegram/outbound";
import {
  registerTelegramVoiceSynthesisProvider,
  registerTelegramVoiceTranscriptionProvider,
} from "@llblab/pi-telegram/voice";
```

`0.12.0` intentionally removes the published `@llblab/pi-telegram/lib/*.ts` compatibility wildcard. Integrations should use the public API domain subpaths above. Package exports point at `/api/*.ts` membranes that re-export only stable companion-extension symbols; implementation modules under `lib/` remain package-private. Telegram command extensions use `/commands` as an explicit opt-in surface instead of automatically exposing arbitrary π slash commands to Telegram. See [Public API Smoke Examples](#public-api-smoke-examples) below for minimal companion-extension patterns that avoid implementation imports.

## User-Facing API

### π commands

Stable commands inside π:

- `/telegram-setup` — configure/update the bot token.
- `/telegram-connect` — start polling here and acquire external Telegram control ownership. Accepted queue/reply state stays local if ownership later moves elsewhere.
- `/telegram-disconnect` — stop polling and release ownership without deleting or silencing accepted local queue state.
- `/telegram-status` — show connection, polling, execution, queue, and recent event diagnostics.

### Telegram commands

Stable commands inside the paired Telegram DM:

- `/start` — pair when needed and open the main application menu.
- `/compact` — open confirmation and compact when idle.
- `/next` — dispatch the next queued turn, aborting active work first when needed.
- `/continue` — enqueue a priority `continue` prompt.
- `/abort` — abort active work and keep the queue; abort-history is scoped to Telegram-owned active turns.
- `/stop` — abort active Telegram-owned work and clear waiting Telegram queue items.

Hidden compatibility shortcuts may open sections directly: `/help`, `/status`, `/model`, `/thinking`, `/queue`, and `/settings`.

This command surface is a mobile companion subset, not a raw terminal-command bridge. Commands that depend on Pi's interactive runtime owning session replacement, TUI transcript clearing, or arbitrary slash-command dispatch stay out of the stable Telegram API unless Pi exposes a safe public extension hook for them.

### Tools and assistant-authored actions

- `telegram_attach(paths, chat_id?, caption?)` is the stable artifact delivery tool for generated files. During Telegram turns it queues files for the active reply; outside Telegram turns it sends files directly to the paired/default chat or explicit `chat_id` when this π instance owns `/telegram-connect`.
- `telegram_message(text, chat_id?)` sends a direct Telegram Markdown message from local/TUI-initiated work when this π instance owns `/telegram-connect`. Top-level `telegram_button` comments inside `text` are parsed with the same planner used for normal replies and attached to that message; buttons are never standalone Telegram messages.
- `telegram_voice` hidden comments request Telegram-native voice delivery.
- `telegram_button` hidden comments create inline buttons whose taps enqueue prompts. Use top-level column-zero comments outside code, quotes, lists, and indented examples; do not emit JSON button specs or standalone button actions.

Prompt guidance is context-aware: local/TUI prompts see only explicit direct-delivery guidance, while Telegram-originated turns receive the full action-comment syntax and phone-width output contract.

See [Outbound Handlers](./outbound.md) for exact markup forms.

## Configuration API

Configuration lives in `~/.pi/agent/telegram.json` unless `PI_CODING_AGENT_DIR` changes the agent root.

Stable config keys:

```ts
interface TelegramConfig {
  botToken?: string;
  botUsername?: string; // runtime-managed
  botId?: number; // runtime-managed
  allowedUserId?: number;
  lastUpdateId?: number; // runtime-managed
  proactivePush?: boolean;
  inboundHandlers?: TelegramInboundHandlerConfig[];
  attachmentHandlers?: TelegramInboundHandlerConfig[]; // compatibility alias
  outboundHandlers?: TelegramOutboundHandlerConfig[];
  voice?: {
    replyMode?: "manual" | "mirror" | "always";
    sendTranscript?: boolean;
  };
  time?: {
    injectionMode?: "hidden" | "always" | "interval";
    interval?: number;
  };
}
```

Hidden/default semantics are represented by absence:

- Voice Reply `hidden`: no `voice.replyMode` key is persisted.
- Time Injection `hidden`: no `time.injectionMode` key is persisted; if `time` becomes empty, the whole `time` object may be omitted.

Environment variables are stable only where documented in the README: bot-token bootstrap, proxy behavior, agent root, and inbound/outbound file size limits.

## Programmatic API Matrix

High-level stable APIs:

- `registerTelegramSection()`
  - Identity: required `id`.
  - Purpose: managed menu/settings UI surfaces.
- `registerTelegramCommand()`
  - Identity: command name.
  - Purpose: explicit opt-in Telegram-native slash commands for companion workflows.
- `registerTelegramStatusLineProvider()`
  - Identity: required `id`.
  - Purpose: compact companion status rows in the `/start` menu status text.
- `registerTelegramVoiceTranscriptionProvider()`
  - Identity: required stable `id` for new code.
  - Purpose: STT fallback for voice/audio input.
- `registerTelegramVoiceSynthesisProvider()`
  - Identity: required stable `id` for new code.
  - Purpose: TTS fallback for Telegram voice replies.

Low-level stable buses:

- `registerTelegramUpdateHandler()`
  - Identity: no id.
  - Purpose: observe or consume raw Telegram updates before default routing.
- `registerTelegramInboundHandler()`
  - Identity: no id.
  - Purpose: generic Telegram-to-π transforms.
- `registerTelegramOutboundHandler()`
  - Identity: no id.
  - Purpose: generic final-reply transforms or voice command fallbacks.

Advanced stable diagnostics:

- `recordTelegramRuntimeEvent()`
  - Identity: caller supplies category.
  - Purpose: surface companion diagnostics in `/telegram-status`.

All registration APIs return a disposer. Companion extensions should call disposers on shutdown and re-register on session start when they recreate runtime state. Low-level bus APIs intentionally avoid ids and run in registration order. High-level provider/UI APIs require stable identity in their public contract so diagnostics, replacement, and cleanup are understandable. Generated voice-provider ids remain a temporary compatibility path where documented.

## Commands

Import from `@llblab/pi-telegram/commands`. This registers Telegram slash commands only; it does not expose π slash commands and is unrelated to command-template handlers.

```ts
const off = registerTelegramCommand({
  name: "review",
  description: "Review queued work",
  showInMenu: true,
  emoji: "🧩",
  handler: async (ctx) => {
    await ctx.enqueuePrompt(`Review this work: ${ctx.args}`);
  },
});
```

Contract:

- Command names are Telegram Bot API names: lowercase `a-z`, digits, and `_`, up to 32 characters. Hyphenated names are rejected.
- Built-in bridge commands such as `/start`, `/compact`, `/next`, `/abort`, and `/stop` are reserved and cannot be claimed by extensions.
- Duplicate extension command names are rejected. The disposer removes only its own command registration.
- Routing precedence is built-in bridge commands first, registered extension commands second, and prompt-template aliases after that. This lets an extension intentionally claim a command name; prompt-template owners can resolve collisions by renaming the template alias.
- `showInMenu` defaults to `false`. When `true`, `emoji` is required and the command appears in `/start` help with that marker; it also joins Bot API command sync only when `description` is provided, because Telegram command-list entries require descriptions. The emoji is prefixed to the Bot API description as well. Workflow/product commands should opt in deliberately instead of expanding the core command row by default.
- The command context currently provides `name`, `args`, `reply(text)`, and `enqueuePrompt(prompt)`. Use `enqueuePrompt()` when a command should create normal queued π work rather than perform immediate Telegram-side handling.
- Handler failures are isolated: the bridge records a `telegram-command` runtime diagnostic, sends a compact failure reply, and keeps Telegram polling/routing alive.

Core commands stay reserved for bridge lifecycle, transport ownership, queue safety, and essential operator controls. Opinionated workflow commands should live in companion extensions through this registry.

## Sections

Import from `@llblab/pi-telegram/sections`.

```ts
const unregister = registerTelegramSection({
  id: "@scope/my-extension",
  label: "🧩 My extension",
  order: 10,
  render: async (ctx) => ({
    text: "<b>My extension</b>",
    parseMode: "html",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "▶️ Run", callback_data: ctx.callbackData("run") }],
      ],
    },
  }),
  handleCallback: async (ctx) => {
    if (ctx.action !== "run") return "pass";
    await ctx.enqueuePrompt("Run my extension workflow.");
    await ctx.answerCallback("Queued");
    return "handled";
  },
});
```

Contract:

- `id` is unique per active registry. Duplicate ids are rejected.
- `ctx.callbackData(action, payload?)` builds compact `section:` callbacks and validates Telegram's 64-byte limit.
- `ctx.edit()` auto-prepends the correct Back/Main-menu row. `ctx.open()` sends a standalone chat message without auto-navigation.
- Section dynamic-label, render, and callback errors are isolated, surfaced as callback popups where applicable, and reflected by `getTelegramSectionDiagnostics()` until the matching surface succeeds.

Full behavior: [Extension Sections](./sections.md).

## Status Lines

Import from `@llblab/pi-telegram/status`.

```ts
const off = registerTelegramStatusLineProvider(
  ({ activeModel }) => {
    if (activeModel?.provider !== "example-provider") return undefined;
    return { label: "service", value: "ready" };
  },
  { id: "@scope/example-status" },
);
```

Contract:

- Providers are synchronous because `/start` status text is rendered inline with the menu.
- Return `undefined` when the line is not relevant for the active model.
- Provider failures are isolated and skipped so optional companion status cannot break the core Telegram menu.
- The bridge renders rows as `<Label>: <value>` in the same HTML status block as Status, Usage, Cost, and Context, capitalizing the first label character for Telegram UI consistency.

## Updates

Import from `@llblab/pi-telegram/updates`.

```ts
const off = registerTelegramUpdateHandler(async (update) => {
  const data = (update as { callback_query?: { data?: string } }).callback_query
    ?.data;
  if (!data?.startsWith("myext:")) return "pass";
  await handleMyCallback(data);
  return "consume";
});
```

Use this as a low-level escape hatch. Prefer sections for menu-integrated UI.

Full behavior: [Updates](./updates.md).

## Inbound

Import from `@llblab/pi-telegram/inbound`.

```ts
const off = registerTelegramInboundHandler("document", async ({ file }) => {
  if (!file?.mimeType?.includes("pdf")) return undefined;
  return await extractPdfText(file.path);
});
```

Priority order:

1. configured `inboundHandlers`
2. compatibility `attachmentHandlers`
3. programmatic inbound handlers
4. voice transcription providers
5. built-in text-file fallback

Full behavior: [Inbound Handlers](./inbound.md).

## Outbound

Import from `@llblab/pi-telegram/outbound`.

```ts
const off = registerTelegramOutboundHandler("text", async (text) => {
  return await rewriteFinalText(text);
});
```

Programmatic outbound handlers are fallbacks/transformers behind operator-owned `telegram.json` configuration. Voice delivery priority is configured voice handlers, then programmatic `voice` handlers, then synthesis providers.

Full behavior: [Outbound Handlers](./outbound.md).

## Voice Providers

Import from `@llblab/pi-telegram/voice`.

```ts
const offStt = registerTelegramVoiceTranscriptionProvider(
  async (file) => {
    if (file.kind !== "voice" && file.kind !== "audio") return undefined;
    return { text: await transcribe(file.path) };
  },
  { id: "@scope/my-extension/stt" },
);

const offTts = registerTelegramVoiceSynthesisProvider(
  async (text, options) => {
    const audioPath = await synthesizeOggOpus(text, options);
    return getTelegramVoiceSendTranscript(getCurrentTelegramConfigView())
      ? { audioPath, transcriptText: text }
      : { audioPath };
  },
  { id: "@scope/my-extension/tts" },
);
```

Stable voice-provider registrations pass a durable `id`. Omitting `id` is a compatibility path for older providers and receives a generated session-local id. Providers return `undefined` to pass. TTS providers must return `.ogg` or `.opus` files for native Telegram voice notes. `voice.sendTranscript` is the bridge-owned transcript preference; providers that expose captions should gate `transcriptText` with `getTelegramVoiceSendTranscript(config)` instead of defining a second reply-policy toggle.

Full behavior: [Voice Integration](./voice.md).

## Public API Smoke Examples

Minimal companion-extension examples that import only stable `@llblab/pi-telegram/*` public membranes. Copy one into an extension `index.ts`, load it beside `pi-telegram`, and verify that it starts without importing any `@llblab/pi-telegram/lib/*` implementation path.

### Extension Sections

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";

export default function demoSection(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramSection({
      id: "demo-section/status",
      label: "🧩 Demo section",
      order: 50,
      render: () => ({
        text: "<b>Demo section</b>\n\nThis section was rendered by a companion extension.",
        replyMarkup: { inline_keyboard: [] },
      }),
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Raw Update Handler

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";

export default function demoUpdates(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramUpdateHandler((update) => {
      if (!update || typeof update !== "object") return "pass";
      return "pass";
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Inbound Handler

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramInboundHandler } from "@llblab/pi-telegram/inbound";

export default function demoInbound(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramInboundHandler("text/*", async (file) => {
      if (!file.path.endsWith(".demo.txt")) return undefined;
      return `Demo inbound handler saw ${file.fileName ?? file.path}`;
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Outbound Handler

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramOutboundHandler } from "@llblab/pi-telegram/outbound";

export default function demoOutbound(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramOutboundHandler("text", async (text) => {
      if (!text.includes("[demo-outbound]")) return undefined;
      return text.replace("[demo-outbound]", "Demo outbound handler:");
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Voice Providers

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getTelegramVoiceSendTranscript,
  registerTelegramVoiceSynthesisProvider,
  registerTelegramVoiceTranscriptionProvider,
} from "@llblab/pi-telegram/voice";

export default function demoVoice(pi: ExtensionAPI) {
  let unregisterTts: (() => void) | undefined;
  let unregisterStt: (() => void) | undefined;
  let currentConfig: { voice?: { sendTranscript?: boolean } } = {};
  pi.on("session_start", async () => {
    unregisterTts?.();
    unregisterStt?.();
    unregisterTts = registerTelegramVoiceSynthesisProvider(
      async (text) => {
        const audioPath = await synthesizeDemoOgg(text);
        return getTelegramVoiceSendTranscript(currentConfig)
          ? { audioPath, transcriptText: text }
          : { audioPath };
      },
      { id: "demo-voice/tts" },
    );
    unregisterStt = registerTelegramVoiceTranscriptionProvider(
      async (file) => {
        if (file.kind !== "voice" && file.kind !== "audio") return undefined;
        return { text: `Demo transcript for ${file.fileName ?? file.path}` };
      },
      { id: "demo-voice/stt" },
    );
  });
  pi.on("session_shutdown", async () => {
    unregisterTts?.();
    unregisterStt?.();
    unregisterTts = undefined;
    unregisterStt = undefined;
  });
}

async function synthesizeDemoOgg(_text: string): Promise<string> {
  throw new Error("Replace synthesizeDemoOgg with a real OGG/Opus generator.");
}
```

### Smoke Checklist

- The extension imports only `@llblab/pi-telegram/sections`, `/updates`, `/inbound`, `/outbound`, `/voice`, or `/keyboard`.
- It does not import `@llblab/pi-telegram/lib/*`.
- It registers on `session_start` and disposes on `session_shutdown`.
- Stable high-level registrations use durable ids.
- Failures are visible during manual testing through `/telegram-status` or extension-owned logging.

## Callback Namespaces

Owned prefixes are reserved by `pi-telegram`: `compact:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, and `section:`.

Companion extensions should use their own short prefix for raw callbacks or use `ctx.callbackData()` inside sections. Unknown unowned callbacks may be forwarded to π as `[callback] <data>` after built-in handlers decline them.

Full behavior: [Callback Namespaces](./callback-namespaces.md).

## Internal Surface

The following are not stable public contracts unless explicitly documented elsewhere:

- queue/runtime/lifecycle stores and planners
- menu implementation helpers
- polling/lock internals
- Telegram API transport helpers
- rendering internals
- command implementation helpers
- test support functions

They are intentionally not exposed through a `./lib/*.ts` export wildcard in `0.12.0`.
