/**
 * Telegram disposable runtime recovery classification
 * Zones: filesystem diagnostics, unclean-shutdown recovery
 * Owns fail-safe classification of temporary ownership and routing artifacts
 */
import { renameSync } from "node:fs";
import { type TelegramFileTransactionOptions } from "./locks.ts";
export type TelegramRuntimeArtifactKind = "owners" | "state" | "transaction";
export interface TelegramRuntimeCorruptArtifact {
    kind: TelegramRuntimeArtifactKind;
    path: string;
    reason: string;
}
export type TelegramRuntimeRecoveryClassification = {
    kind: "clean";
} | {
    kind: "recoverable-corruption";
    artifacts: TelegramRuntimeCorruptArtifact[];
} | {
    kind: "blocked-live-owner";
    artifacts: TelegramRuntimeCorruptArtifact[];
    livePids: number[];
};
export interface TelegramRuntimeRecoveryClassificationOptions {
    ownersPath: string;
    statePaths?: readonly string[];
    transactionPath?: string;
    isProcessAlive?: (pid: number) => boolean;
    nowMs?: number;
    staleHeartbeatMs?: number;
    ignoredTransactionPids?: readonly number[];
}
export type TelegramRuntimeRecoveryResult = {
    kind: "not-needed";
} | {
    kind: "blocked-live-owner";
    livePids: number[];
    quarantineDir?: string;
} | {
    kind: "recovered";
    artifacts: TelegramRuntimeCorruptArtifact[];
    quarantineDir: string;
};
export interface TelegramRuntimeRecoveryOptions extends TelegramRuntimeRecoveryClassificationOptions {
    recoveryTransactionPath?: string;
    quarantineRoot?: string;
    pid?: number;
    getNowMs?: () => number;
    quarantineRename?: typeof renameSync;
    quarantineRenameRetryDelayMs?: number;
    transactionOptions?: TelegramFileTransactionOptions;
}
export type TelegramPollingStartRecoveryDecision = {
    kind: "unhandled";
} | {
    kind: "retry";
    message: string;
} | {
    kind: "blocked";
    message: string;
};
export interface TelegramPollingStartRecoveryHandlerDeps {
    getOwnersPath: () => string;
    getStatePaths: () => readonly string[];
    suspendPolling: () => Promise<unknown>;
    releaseOwnership?: () => unknown | Promise<unknown>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
/**
 * Classify disposable runtime corruption without mutating any artifact.
 *
 * Corruption remains recoverable only when neither owners.json nor a
 * verifiable transaction marker identifies a process that is still alive.
 */
export declare function classifyTelegramRuntimeRecovery(options: TelegramRuntimeRecoveryClassificationOptions): TelegramRuntimeRecoveryClassification;
/**
 * Quarantine classifier-approved disposable corruption under two guards.
 *
 * A dedicated recovery transaction serializes recoverers. The ownership
 * transaction then prevents a new Telegram owner from appearing between the
 * final classification and mutation. Every artifact is renamed within its
 * filesystem; durable config and diagnostics never enter the candidate set.
 */
export declare function recoverTelegramRuntimeState(options: TelegramRuntimeRecoveryOptions): TelegramRuntimeRecoveryResult;
/** Build the `/telegram-connect` recovery boundary around runtime artifacts. */
export declare function createTelegramPollingStartRecoveryHandler(deps: TelegramPollingStartRecoveryHandlerDeps): () => Promise<TelegramPollingStartRecoveryDecision>;
