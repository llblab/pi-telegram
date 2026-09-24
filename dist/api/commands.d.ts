/**
 * Public Telegram commands API
 * Zones: package boundary, extension interop
 * Exposes the stable Telegram slash-command registration surface while keeping registry internals package-private
 */
export { registerTelegramCommand, type TelegramExtensionCommandContext, type TelegramExtensionCommandRegistration, } from "../lib/commands.ts";
