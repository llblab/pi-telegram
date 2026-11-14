/**
 * Telegram package entrypoint
 * Zones: telegram, pi agent, public API
 * Anchors host-loader SDK mapping without adding SDK values to cold domains.
 */

import extension from "./lib/extension.ts";
import { SettingsManager } from "./lib/pi-host.ts";
import * as Pi from "./lib/pi.ts";

export default function (pi: Pi.ExtensionAPI) {
  return extension(pi, (cwd) => Pi.createSettingsManager(cwd, SettingsManager));
}
