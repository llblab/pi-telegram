/**
 * Public Telegram inbound API
 * Zones: package boundary, extension interop
 * Exposes the stable programmatic inbound handler surface while keeping handler runtime internals package-private
 */
export { registerTelegramInboundHandler, type TelegramInboundHandlerFile, type TelegramInboundHandlerOutput, type TelegramInboundProgrammaticHandler, type TelegramInboundProgrammaticHandlerInput, type TelegramInboundProgrammaticHandlerResult, } from "../lib/inbound.ts";
