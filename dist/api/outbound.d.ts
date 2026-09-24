/**
 * Public Telegram outbound API
 * Zones: package boundary, extension interop
 * Exposes stable outbound handler and diagnostics surfaces while keeping delivery internals package-private
 */
export { recordTelegramRuntimeEvent, registerTelegramOutboundHandler, type TelegramOutboundProgrammaticHandler, } from "../lib/outbound.ts";
