/**
 * Shutdown handlers for the Telegram bridge.
 * Zones: lifecycle, globals
 *
 * Centralizes shutdown logic so the entrypoint remains a pure composition root.
 */

import type { ExtensionAPI } from "./pi.ts";

export function registerTelegramBridgeShutdownHandlers(
  lifecycle: Pick<ExtensionAPI, "on">,
  globalKeys: readonly string[],
): void {
  lifecycle.on("session_shutdown", () => {
    for (const key of globalKeys) {
      (globalThis as Record<string, unknown>)[key] = undefined;
    }
  });
}
