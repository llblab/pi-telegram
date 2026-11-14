import extension from "../index.js";
import { SettingsManager } from "../lib/pi-host.js";
import * as Pi from "../lib/pi.js";
export default function (pi) {
  return extension(pi, (cwd) => Pi.createSettingsManager(cwd, SettingsManager));
}
