/**
 * Public Telegram updates API
 * Zones: package boundary, extension interop
 * Exposes the stable raw-update handler surface while keeping update routing internals package-private
 */
export { assertTelegramUpdateExecutionCurrent, carryTelegramUpdateExecutionFence, createTelegramUpdateExecutionFenceGuard, getTelegramUpdateExecutionFence, registerTelegramUpdateHandler, type TelegramUpdateExecutionFence, type TelegramUpdateHandler, type TelegramUpdateHandlerVerdict, } from "../lib/updates.ts";
