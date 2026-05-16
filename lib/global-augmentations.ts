/**
 * Central TypeScript global augmentations for pi-telegram.
 *
 * Purpose:
 * - All `declare global` blocks live in this single file.
 * - This avoids scattering global augmentations across many modules.
 * - The actual key strings are defined in ./globals.ts.
 *
 * Note: The previous persistent registration globals have been removed as part of the
 * Voice v2 PR cleanup (Issue #29).
 *
 * Zones: shared, globals, typescript
 */

// All types below are imported inline (using `import("./path")` syntax) to avoid
// circular dependency problems while keeping this file as the single source of
// truth for pi-telegram's global augmentations.

declare global {
  // === Section-related globals ===
  // eslint-disable-next-line no-var
  var __piTelegramSectionRegistry__:
    | import("./extension-sections.ts").TelegramSectionRegistry
    | undefined;

  // === Voice-related globals ===
  // eslint-disable-next-line no-var
  var __piTelegramVoiceProviders__:
    | Map<string, import("./outbound-handlers.ts").TelegramVoiceProvider>
    | undefined;

  // eslint-disable-next-line no-var
  var __piTelegramVoiceEventRecorder__:
    | ((category: string, error: unknown, details?: Record<string, unknown>) => void)
    | undefined;

  // Voice configuration (written by voice extensions, read as fallback)
  // eslint-disable-next-line no-var
  var __piTelegramVoiceConfig__:
    | { replyMode?: string }
    | undefined;

  // === Other extension globals ===
  // eslint-disable-next-line no-var
  var __piTelegramOutboundHandlers__:
    | import("./outbound-handlers.ts").TelegramOutboundHandlerRegistry
    | undefined;

  // eslint-disable-next-line no-var
  var __piTelegramExternalHandlerRegistry__:
    | import("./external-handlers.ts").TelegramExternalHandlerRegistry
    | undefined;
}
