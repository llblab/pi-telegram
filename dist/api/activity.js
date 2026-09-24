/**
 * Public Telegram activity API
 * Zones: package boundary, pi agent lifecycle, extension interop
 * Exposes normalized non-blocking activity registration while keeping lifecycle wiring and dispatch internals package-private
 */
export { registerTelegramActivityHandler, } from "../lib/activity.js";
