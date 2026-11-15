/**
 * Telegram bridge extension composition and orchestration layer
 * Zones: telegram, pi agent, orchestration
 * Keeps runtime wiring in one place while the generated runtime entrypoint supplies loader-mapped host settings
 */
import * as Pi from "./pi.ts";
export default function (pi: Pi.ExtensionAPI, createSettingsManager?: typeof Pi.createSettingsManager): void;
