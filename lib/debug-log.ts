/**
 * Telegram multi-instance debug log — writes to <agentDir>/tmp/telegram/debug.jsonl
 * MULTI-INSTANCE: auto-detects Pi vs OMP agent dir.
 * Each call appends one JSON line. Safe to call from anywhere (try/catch around write).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function telegramGetAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) {
    return resolve(process.env.PI_CODING_AGENT_DIR);
  }
  const home = homedir();
  const execBasename =
    (process.execPath || "").toLowerCase().split("/").pop() ?? "";
  const argv1Last =
    (process.argv[1] ?? "").toLowerCase().split("/").pop() ?? "";
  if (execBasename.startsWith("omp") || argv1Last.startsWith("omp")) {
    return join(home, ".omp", "agent");
  }
  return join(home, ".pi", "agent");
}

let DEBUG_ENABLED: boolean | undefined;
function isDebugEnabled(): boolean {
  if (DEBUG_ENABLED === undefined) {
    const v = process.env.PI_TELEGRAM_DEBUG;
    DEBUG_ENABLED = v === "1" || v === "true" || v === "yes";
    // Default: ON (debug build). Set PI_TELEGRAM_DEBUG=0 to disable.
    if (v === undefined) DEBUG_ENABLED = true;
  }
  return DEBUG_ENABLED;
}

export function telegramDebugLog(
  category: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!isDebugEnabled()) return;
  try {
    const path = join(telegramGetAgentDir(), "tmp", "telegram", "debug.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      category,
      message,
      ...(details ?? {}),
    });
    appendFileSync(path, line + "\n", { encoding: "utf8" });
  } catch {
    // never throw from debug logging
  }
}

// REVIEWER (iteration 7): build stamp so a live test can PROVE which code is
// running. Prior "live tests" ran stale in-memory code (see history.md §12.6).
// Bump TELEGRAM_BUILD_STAMP on every code change; the first thing a test must
// check is that this stamp appears fresh in debug.jsonl at process start.
export const TELEGRAM_BUILD_STAMP = "iter7-reviewer-2026-07-06";

let bootStampEmitted = false;
export function telegramEmitBootStamp(module: string): void {
  // Emit once per module load; harmless if called from several modules.
  telegramDebugLog("boot", "module loaded", {
    module,
    build: TELEGRAM_BUILD_STAMP,
  });
  bootStampEmitted = true;
}

export function telegramBootStampEmitted(): boolean {
  return bootStampEmitted;
}
