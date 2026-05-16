/**
 * Shutdown handlers for the Telegram bridge.
 * Zones: lifecycle, globals
 *
 * Centralizes shutdown logic so the entrypoint remains a pure composition root.
 */

export function registerTelegramBridgeShutdownHandlers(
  lifecycle: { on: (event: string, handler: () => void) => void },
  globalKeys: readonly string[],
): void {
  lifecycle.on("shutdown", () => {
    for (const key of globalKeys) {
      (globalThis as Record<string, unknown>)[key] = undefined;
    }
  });
}
