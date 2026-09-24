/**
 * Public Telegram updates API
 * Zones: package boundary, extension interop
 * Exposes the stable raw-update handler surface while keeping update routing internals package-private
 */
export { assertTelegramUpdateExecutionCurrent, carryTelegramUpdateExecutionFence, createTelegramUpdateExecutionFenceGuard, getTelegramUpdateExecutionFence, registerTelegramUpdateHandler, } from "../lib/updates.js";
