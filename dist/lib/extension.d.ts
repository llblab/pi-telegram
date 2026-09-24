/**
 * Telegram bridge extension composition and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps runtime wiring in one place while the package entrypoint remains a thin re-export
 */
import * as Pi from "./pi.ts";
export default function (pi: Pi.ExtensionAPI): void;
