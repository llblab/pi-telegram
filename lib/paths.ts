/**
 * Telegram bridge path resolution for Pi-compatible runtimes
 * Zones: telemetry paths, filesystem, runtime identity
 * Owns agent-dir detection and extension-local path derivation
 *
 * This domain is pure/path-only: it resolves directories and file paths
 * from environment and runtime identity. It does not read config, manage
 * state, or import broader Telegram domains.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const TELEGRAM_DEFAULT_PROFILE_NAME = "default";

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

/** Telegram bridge temporary directory (<agentDir>/tmp/telegram). */
export function resolveTelegramTempDir(agentDir = resolveAgentDir()): string {
  return join(agentDir, "tmp", "telegram");
}

/** Telegram transport ownership store (<agentDir>/tmp/telegram/owners.json). */
export function resolveTelegramOwnersPath(): string {
  return join(resolveTelegramTempDir(), "owners.json");
}

export function getTelegramProfilePathSuffix(profileName?: string): string {
  if (!profileName || profileName === TELEGRAM_DEFAULT_PROFILE_NAME) return "";
  return `.${profileName.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
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
  const profileSlug = suffix.slice(1);
  return {
    state: `~/.pi/agent/tmp/telegram/state${suffix}.json`,
    logs: `~/.pi/agent/tmp/telegram/logs${profileSlug ? `.${profileSlug}` : ""}.jsonl`,
  };
}

/** Durable Workspace admission ledger (<agentDir>/tmp/telegram/workspace-admission[.<profile>].json). */
export function resolveTelegramWorkspaceAdmissionPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveTelegramProfileTempFilePath(
    "workspace-admission",
    "json",
    agentDir,
    profileName,
  );
}

/** Durable inactive Thread cleanup work-set journal. */
export function resolveTelegramThreadCleanupWorkPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveTelegramProfileTempFilePath("thread-cleanup", "json", agentDir, profileName);
}

/** Durable agent-authored channel post journal. */
export function resolveTelegramChannelPostJournalPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveTelegramProfileTempFilePath("channel-posts", "json", agentDir, profileName);
}

/** Durable inbound update journal (<agentDir>/tmp/telegram/inbox[.<profile>].json). */
export function resolveTelegramUpdateJournalPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveTelegramProfileTempFilePath(
    "inbox",
    "json",
    agentDir,
    profileName,
  );
}

/** Durable follower delivery journal, isolated by stable recipient binding. */
export function resolveTelegramFollowerJournalPath(
  recipientBindingKey: string,
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  if (!recipientBindingKey) {
    throw new Error("Telegram follower journal binding key is required.");
  }
  const bindingHash = createHash("sha256")
    .update(recipientBindingKey)
    .digest("hex")
    .slice(0, 16);
  return resolveTelegramProfileTempFilePath(
    `follower-inbox-${bindingHash}`,
    "json",
    agentDir,
    profileName,
  );
}

/** Runtime event log (<agentDir>/tmp/telegram/logs.jsonl). */
export function resolveTelegramRuntimeLogPath(): string {
  return resolveTelegramProfileTempFilePath("logs", "jsonl");
}
