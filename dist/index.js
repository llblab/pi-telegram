/**
 * Telegram package entrypoint
 * Zones: telegram, pi agent, public API
 * Anchors host-loader SDK mapping without adding SDK values to cold domains.
 */
import extension from "./lib/extension.js";
import { SettingsManager } from "./lib/pi-host.js";
import * as Pi from "./lib/pi.js";
export default function (pi) {
    return extension(pi, (cwd) => Pi.createSettingsManager(cwd, SettingsManager));
}
