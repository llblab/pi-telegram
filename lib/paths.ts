/**
 * Telegram bridge path resolution for Pi-compatible runtimes
 * Zones: telemetry paths, filesystem, runtime identity
 * Owns agent-dir detection and extension-local path derivation
 *
 * This domain is pure/path-only: it resolves directories and file paths
 * from environment and runtime identity. It does not read config, manage
 * state, or import broader Telegram domains.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve the agent data directory for the current Pi-compatible runtime.
 *
 * Precedence:
 * 1. `PI_CODING_AGENT_DIR` env variable, when explicitly set.
 * 2. Detect Pi-compatible runtime identity from the executable or argv[1]
 *    (e.g. OMP vs standard Pi agent).
 * 3. Fallback: `~/.pi/agent`.
 */
export function resolveAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) {
    return resolve(process.env.PI_CODING_AGENT_DIR);
  }
  const execBasename =
    (process.execPath || "").toLowerCase().split("/").pop() ?? "";
  const argv1Last =
    (process.argv[1] ?? "").toLowerCase().split("/").pop() ?? "";
  if (execBasename.startsWith("omp") || argv1Last.startsWith("omp")) {
    return join(homedir(), ".omp", "agent");
  }
  return join(homedir(), ".pi", "agent");
}

/** Telegram bridge configuration file (<agentDir>/telegram.json). */
export function resolveTelegramConfigPath(): string {
  return join(resolveAgentDir(), "telegram.json");
}

/** Telegram singleton lock file (<agentDir>/locks.json). */
export function resolveTelegramLocksPath(): string {
  return join(resolveAgentDir(), "locks.json");
}

/** Telegram bridge temporary directory (<agentDir>/tmp/telegram). */
export function resolveTelegramTempDir(): string {
  return join(resolveAgentDir(), "tmp", "telegram");
}

/** Telegram bus leader socket path (<agentDir>/tmp/telegram/bus.sock). */
export function resolveTelegramBusSocketPath(): string {
  return join(resolveAgentDir(), "tmp", "telegram", "bus.sock");
}

/** Runtime event log (<agentDir>/tmp/telegram/logs.jsonl). */
export function resolveTelegramRuntimeLogPath(): string {
  return join(resolveAgentDir(), "tmp", "telegram", "logs.jsonl");
}
