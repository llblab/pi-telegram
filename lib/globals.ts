/**
 * Centralized registry of all globalThis keys used by pi-telegram.
 *
 * These are internal implementation details. They exist primarily to allow
 * communication between the core bridge and extensions (especially voice
 * and section providers) across different module boundaries and to survive
 * certain reload scenarios.
 *
 * Zones: shared, globals
 */

//
// Voice-related globals
//
export const VOICE_EVENT_RECORDER_KEY = "__piTelegramVoiceEventRecorder__" as const;
export const VOICE_CONFIG_KEY = "__piTelegramVoiceConfig__" as const;
export const VOICE_PROVIDER_REGISTRY_KEY = "__piTelegramVoiceProviders__" as const;

//
// Section-related globals
//
export const SECTION_REGISTRY_KEY = "__piTelegramSectionRegistry__" as const;

//
// Other extension globals
//
export const OUTBOUND_HANDLER_REGISTRY_KEY = "__piTelegramOutboundHandlers__" as const;
export const EXTERNAL_HANDLER_REGISTRY_KEY = "__piTelegramExternalHandlerRegistry__" as const;

/**
 * All known pi-telegram globalThis keys.
 * Useful for debugging or complete shutdown/reset logic.
 */
export const ALL_PI_TELEGRAM_GLOBAL_KEYS = [
  VOICE_EVENT_RECORDER_KEY,
  VOICE_CONFIG_KEY,
  VOICE_PROVIDER_REGISTRY_KEY,
  SECTION_REGISTRY_KEY,
  OUTBOUND_HANDLER_REGISTRY_KEY,
  EXTERNAL_HANDLER_REGISTRY_KEY,
] as const;
