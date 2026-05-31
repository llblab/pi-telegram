/**
 * Public Telegram status API
 * Zones: package boundary, companion extension interop
 * Exposes compact status-menu line registration for companion extensions while keeping status rendering internals package-private
 */

export {
  registerTelegramStatusLineProvider,
  type TelegramStatusLineProvider,
  type TelegramStatusLineProviderContext,
  type TelegramStatusLineProviderResult,
} from "../lib/status.ts";
