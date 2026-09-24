export declare const TELEGRAM_DEFAULT_PROFILE_NAME = "default";
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
export declare function resolveAgentDir(input?: TelegramAgentDirResolutionInput): string;
/**
 * Pure reference preflight against an independently approved resource path.
 * Reject aliases; never repair relative historical references or redirect storage.
 * Equality proves spelling only, not file identity, consumer closure or migration readiness.
 */
export declare function requireTelegramStoragePathReference(path: string, expectedPath: string): string;
/** Telegram bridge configuration file (<agentDir>/telegram.json). */
export declare function resolveTelegramConfigPath(): string;
/** Telegram bridge temporary directory (<agentDir>/tmp/telegram). */
export declare function resolveTelegramTempDir(agentDir?: string): string;
/** Telegram transport ownership store (<agentDir>/tmp/telegram/owners.json). */
export declare function resolveTelegramOwnersPath(): string;
export declare function getTelegramProfilePathSuffix(profileName?: string): string;
export declare function resolveTelegramProfileTempFilePath(baseName: string, extension: string, agentDir?: string, profileName?: string): string;
export declare function getTelegramDiagnosticsDisplayPaths(profileName?: string): {
    state: string;
    logs: string;
};
/** Durable Workspace admission ledger (<agentDir>/tmp/telegram/workspace-admission[.<profile>].json). */
export declare function resolveTelegramWorkspaceAdmissionPath(agentDir?: string, profileName?: string): string;
/** Profile-only callback shape; binds storage to the configured agent directory. */
export declare function resolveTelegramWorkspaceAdmissionPathForProfile(profileName?: string): string;
/** Durable inactive Thread cleanup work-set journal. */
export declare function resolveTelegramThreadCleanupWorkPath(agentDir?: string, profileName?: string): string;
/** Durable agent-authored channel post journal. */
export declare function resolveTelegramChannelPostJournalPath(agentDir?: string, profileName?: string): string;
/** Durable inbound update journal (<agentDir>/tmp/telegram/inbox[.<profile>].json). */
export declare function resolveTelegramUpdateJournalPath(agentDir?: string, profileName?: string): string;
/** Profile-only callback shape; binds storage to the configured agent directory. */
export declare function resolveTelegramUpdateJournalPathForProfile(profileName?: string): string;
/** Durable follower delivery journal, isolated by stable recipient binding. */
export declare function resolveTelegramFollowerJournalPath(recipientBindingKey: string, agentDir?: string, profileName?: string): string;
/** Runtime event log (<agentDir>/tmp/telegram/logs.jsonl). */
export declare function resolveTelegramRuntimeLogPath(): string;
