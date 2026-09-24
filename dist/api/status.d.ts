/**
 * Public Telegram status API
 * Zones: package boundary, extension interop
 * Exposes compact status-menu line registration for extension consumers while keeping status rendering internals package-private
 */
export { registerTelegramStatusLineProvider, type TelegramStatusLineProvider, type TelegramStatusLineProviderContext, type TelegramStatusLineProviderResult, } from "../lib/status.ts";
