/**
 * Telegram package entrypoint
 * Zones: telegram, pi agent, public API
 * Anchors host-loader SDK mapping without adding SDK values to cold domains.
 */
import * as Pi from "./lib/pi.ts";
export default function (pi: Pi.ExtensionAPI): void;
