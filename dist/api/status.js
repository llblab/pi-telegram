/**
 * Public Telegram status API
 * Zones: package boundary, extension interop
 * Exposes compact status-menu line registration for extension consumers while keeping status rendering internals package-private
 */
export { registerTelegramStatusLineProvider, } from "../lib/status.js";
