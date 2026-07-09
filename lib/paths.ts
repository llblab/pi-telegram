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

export interface TelegramAgentDirResolutionInput {
  env?: Partial<Pick<NodeJS.ProcessEnv, "PI_CODING_AGENT_DIR">>;
  execPath?: string;
  argv?: readonly string[];
}

/**
 * Resolve the agent data directory for the current Pi-compatible runtime.
 *
 * Precedence:
 * 1. `PI_CODING_AGENT_DIR` env variable, when explicitly set.
 * 2. Detect Pi-compatible runtime identity from the executable or argv[1]
 *    (e.g. OMP vs standard Pi agent).
 * 3. Fallback: `~/.pi/agent`.
 */
export function resolveAgentDir(
  input: TelegramAgentDirResolutionInput = {},
): string {
  const env = input.env ?? process.env;
  if (env.PI_CODING_AGENT_DIR) return resolve(env.PI_CODING_AGENT_DIR);
  const execPath = input.execPath ?? process.execPath;
  const argv = input.argv ?? process.argv;
  const execBasename = execPath.toLowerCase().split(/[\\/]/u).pop() ?? "";
  const argv1Last = (argv[1] ?? "").toLowerCase().split(/[\\/]/u).pop() ?? "";
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
export function resolveTelegramTempDir(agentDir = resolveAgentDir()): string {
  return join(agentDir, "tmp", "telegram");
}

export function getTelegramProfilePathSuffix(profileName?: string): string {
  return profileName ? `.${profileName.replace(/[^a-zA-Z0-9._-]+/g, "_")}` : "";
}

export function resolveTelegramProfileTempFilePath(
  baseName: string,
  extension: string,
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return join(
    resolveTelegramTempDir(agentDir),
    `${baseName}${getTelegramProfilePathSuffix(profileName)}.${extension}`,
  );
}

export function getTelegramDiagnosticsDisplayPaths(profileName?: string): {
  state: string;
  logs: string;
} {
  const suffix = getTelegramProfilePathSuffix(profileName);
  return {
    state: `~/.pi/agent/tmp/telegram/state${suffix}.json`,
    logs: `~/.pi/agent/tmp/telegram/logs${suffix}.jsonl`,
  };
}

/** Runtime event log (<agentDir>/tmp/telegram/logs.jsonl). */
export function resolveTelegramRuntimeLogPath(): string {
  return resolveTelegramProfileTempFilePath("logs", "jsonl");
}
