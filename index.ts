/**
 * Telegram package entrypoint
 * Zones: telegram, pi agent, public API
 * Re-exports the extension composition root without owning runtime wiring.
 */

export { default } from "./lib/extension.ts";
