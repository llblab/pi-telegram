/**
 * Telegram disposable runtime recovery classification
 * Zones: filesystem diagnostics, unclean-shutdown recovery
 * Owns fail-safe classification of temporary ownership and routing artifacts
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  isProcessAlive as defaultIsProcessAlive,
  parseTelegramLockEntry,
  renameTelegramPathWithRetry,
  TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
  withTelegramFileTransaction,
  type TelegramFileTransactionOptions,
} from "./locks.ts";

export type TelegramRuntimeArtifactKind = "owners" | "state" | "transaction";

export interface TelegramRuntimeCorruptArtifact {
  kind: TelegramRuntimeArtifactKind;
  path: string;
  reason: string;
}

export type TelegramRuntimeRecoveryClassification =
  | { kind: "clean" }
  | {
      kind: "recoverable-corruption";
      artifacts: TelegramRuntimeCorruptArtifact[];
    }
  | {
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

export type TelegramRuntimeRecoveryResult =
  | { kind: "not-needed" }
  | {
      kind: "blocked-live-owner";
      livePids: number[];
      quarantineDir?: string;
    }
  | {
      kind: "recovered";
      artifacts: TelegramRuntimeCorruptArtifact[];
      quarantineDir: string;
    };

export interface TelegramRuntimeRecoveryOptions
  extends TelegramRuntimeRecoveryClassificationOptions {
  recoveryTransactionPath?: string;
  quarantineRoot?: string;
  pid?: number;
  getNowMs?: () => number;
  quarantineRename?: typeof renameSync;
  quarantineRenameRetryDelayMs?: number;
  transactionOptions?: TelegramFileTransactionOptions;
}

export type TelegramPollingStartRecoveryDecision =
  | { kind: "unhandled" }
  | { kind: "retry"; message: string }
  | { kind: "blocked"; message: string };

export interface TelegramPollingStartRecoveryHandlerDeps {
  getOwnersPath: () => string;
  getStatePaths: () => readonly string[];
  suspendPolling: () => Promise<unknown>;
  releaseOwnership?: () => unknown | Promise<unknown>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

interface ArtifactInspection {
  source: TelegramRuntimeArtifactKind;
  corrupt?: TelegramRuntimeCorruptArtifact;
  ownerPids: number[];
}

const OWNER_FILE_PATTERN = /^owner\.([A-Za-z0-9-]+)\.json$/u;
const RECLAIM_FILE_PATTERN =
  /^owner\.reclaim\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;

function corruption(
  kind: TelegramRuntimeArtifactKind,
  path: string,
  reason: string,
): ArtifactInspection {
  return { source: kind, corrupt: { kind, path, reason }, ownerPids: [] };
}

function inspectOwners(
  path: string,
  nowMs: number,
  staleHeartbeatMs: number,
): ArtifactInspection {
  if (!existsSync(path)) return { source: "owners", ownerPids: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return corruption("owners", path, "owners.json is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return corruption("owners", path, "owners.json is not an object");
  }
  const ownerPids = Object.values(value).flatMap((candidate) => {
    const entry = parseTelegramLockEntry(candidate);
    if (
      !entry ||
      (typeof entry.heartbeatMs === "number" &&
        nowMs - entry.heartbeatMs > staleHeartbeatMs)
    ) {
      return [];
    }
    return [entry.pid];
  });
  return { source: "owners", ownerPids };
}

function inspectState(path: string): ArtifactInspection {
  if (!existsSync(path)) return { source: "state", ownerPids: [] };
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return { source: "state", ownerPids: [] };
  } catch {
    return corruption("state", path, `${basename(path)} is not valid JSON`);
  }
}

function parseTransactionOwner(path: string): number | undefined {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const pid = (value as Record<string, unknown>).pid;
  const acquiredAtMs = (value as Record<string, unknown>).acquiredAtMs;
  const generation = (value as Record<string, unknown>).generation;
  return typeof pid === "number" &&
    typeof acquiredAtMs === "number" &&
    typeof generation === "string"
    ? pid
    : undefined;
}

function inspectTransaction(path: string): ArtifactInspection {
  if (!existsSync(path)) return { source: "transaction", ownerPids: [] };
  try {
    const stat = lstatSync(path);
    let ownerPath: string;
    let expectedOwnerPid: number | undefined;
    if (stat.isDirectory()) {
      const entries = readdirSync(path);
      if (entries.length !== 1) {
        return corruption(
          "transaction",
          path,
          "transaction guard has an unverifiable directory shape",
        );
      }
      const entry = entries[0];
      const ownerMatch = OWNER_FILE_PATTERN.exec(entry);
      const reclaimMatch = RECLAIM_FILE_PATTERN.exec(entry);
      if (!ownerMatch && !reclaimMatch) {
        return corruption(
          "transaction",
          path,
          "transaction guard has an unrecognized owner marker",
        );
      }
      ownerPath = join(path, entry);
      expectedOwnerPid = reclaimMatch ? Number(reclaimMatch[1]) : undefined;
      const ownerPid = parseTransactionOwner(ownerPath);
      if (ownerPid === undefined) {
        return corruption(
          "transaction",
          path,
          "transaction guard owner metadata is invalid",
        );
      }
      if (ownerMatch) {
        const value = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<
          string,
          unknown
        >;
        if (value.generation !== ownerMatch[1]) {
          return corruption(
            "transaction",
            path,
            "transaction guard generation does not match its owner marker",
          );
        }
      }
      return {
        source: "transaction",
        ownerPids: [expectedOwnerPid ?? ownerPid],
      };
    }
    if (!stat.isFile()) {
      return corruption(
        "transaction",
        path,
        "transaction guard has an unsupported filesystem type",
      );
    }
    ownerPath = path;
    const ownerPid = parseTransactionOwner(ownerPath);
    return ownerPid === undefined
      ? corruption(
          "transaction",
          path,
          "legacy transaction guard owner metadata is invalid",
        )
      : { source: "transaction", ownerPids: [ownerPid] };
  } catch {
    return corruption(
      "transaction",
      path,
      "transaction guard cannot be inspected",
    );
  }
}

/**
 * Classify disposable runtime corruption without mutating any artifact.
 *
 * Corruption remains recoverable only when neither owners.json nor a
 * verifiable transaction marker identifies a process that is still alive.
 */
export function classifyTelegramRuntimeRecovery(
  options: TelegramRuntimeRecoveryClassificationOptions,
): TelegramRuntimeRecoveryClassification {
  const transactionPath =
    options.transactionPath ?? `${options.ownersPath}.transaction`;
  const inspections = [
    inspectOwners(
      options.ownersPath,
      options.nowMs ?? Date.now(),
      options.staleHeartbeatMs ?? TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
    ),
    ...(options.statePaths ?? []).map(inspectState),
    inspectTransaction(transactionPath),
  ];
  const artifacts = inspections.flatMap((inspection) =>
    inspection.corrupt ? [inspection.corrupt] : [],
  );
  if (artifacts.length === 0) return { kind: "clean" };

  const processAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const ignoredTransactionPids = new Set(
    options.ignoredTransactionPids ?? [],
  );
  const livePids = [
    ...new Set(
      inspections.flatMap((inspection) =>
        inspection.ownerPids.filter(
          (pid) =>
            !(
              inspection.source === "transaction" &&
              ignoredTransactionPids.has(pid)
            ) && processAlive(pid),
        ),
      ),
    ),
  ].sort((left, right) => left - right);
  return livePids.length > 0
    ? { kind: "blocked-live-owner", artifacts, livePids }
    : { kind: "recoverable-corruption", artifacts };
}

/**
 * Quarantine classifier-approved disposable corruption under two guards.
 *
 * A dedicated recovery transaction serializes recoverers. The ownership
 * transaction then prevents a new Telegram owner from appearing between the
 * final classification and mutation. Every artifact is renamed within its
 * filesystem; durable config and diagnostics never enter the candidate set.
 */
export function recoverTelegramRuntimeState(
  options: TelegramRuntimeRecoveryOptions,
): TelegramRuntimeRecoveryResult {
  const pid = options.pid ?? process.pid;
  const transactionPath =
    options.transactionPath ?? `${options.ownersPath}.transaction`;
  const recoveryTransactionPath =
    options.recoveryTransactionPath ??
    join(dirname(options.ownersPath), "runtime-recovery.transaction");
  const quarantineRoot =
    options.quarantineRoot ?? join(dirname(options.ownersPath), "recovery");
  const classificationOptions = {
    ownersPath: options.ownersPath,
    statePaths: options.statePaths,
    transactionPath,
    isProcessAlive: options.isProcessAlive,
    nowMs: options.nowMs ?? options.getNowMs?.(),
    staleHeartbeatMs: options.staleHeartbeatMs,
  } satisfies TelegramRuntimeRecoveryClassificationOptions;

  return withTelegramFileTransaction(
    recoveryTransactionPath,
    () => {
      const initial = classifyTelegramRuntimeRecovery(classificationOptions);
      if (initial.kind === "clean") return { kind: "not-needed" };
      if (initial.kind === "blocked-live-owner") {
        return {
          kind: "blocked-live-owner",
          livePids: initial.livePids,
        };
      }

      let quarantineDir: string | undefined;
      const recoveredArtifacts: TelegramRuntimeCorruptArtifact[] = [];
      const ensureQuarantineDir = (): string => {
        if (quarantineDir) return quarantineDir;
        quarantineDir = join(
          quarantineRoot,
          `${options.getNowMs?.() ?? Date.now()}-${pid}-${randomUUID()}`,
        );
        mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
        return quarantineDir;
      };
      const quarantineArtifact = (
        artifact: TelegramRuntimeCorruptArtifact,
      ): void => {
        if (!existsSync(artifact.path)) return;
        const destination = join(ensureQuarantineDir(), basename(artifact.path));
        if (
          renameTelegramPathWithRetry(artifact.path, destination, {
            rename: options.quarantineRename,
            retryDelayMs: options.quarantineRenameRetryDelayMs,
          })
        ) {
          recoveredArtifacts.push(artifact);
        }
      };

      for (const artifact of initial.artifacts) {
        if (artifact.kind === "transaction") quarantineArtifact(artifact);
      }

      return withTelegramFileTransaction(
        transactionPath,
        () => {
          const current = classifyTelegramRuntimeRecovery({
            ...classificationOptions,
            ignoredTransactionPids: [process.pid],
          });
          if (current.kind === "blocked-live-owner") {
            return {
              kind: "blocked-live-owner",
              livePids: current.livePids,
              quarantineDir,
            };
          }
          if (current.kind === "recoverable-corruption") {
            for (const artifact of current.artifacts) {
              if (artifact.kind !== "transaction") quarantineArtifact(artifact);
            }
          }
          return recoveredArtifacts.length > 0 && quarantineDir
            ? {
                kind: "recovered",
                artifacts: recoveredArtifacts,
                quarantineDir,
              }
            : { kind: "not-needed" };
        },
        options.transactionOptions,
      );
    },
    options.transactionOptions,
  );
}

/** Build the `/telegram-connect` recovery boundary around runtime artifacts. */
export function createTelegramPollingStartRecoveryHandler(
  deps: TelegramPollingStartRecoveryHandlerDeps,
): () => Promise<TelegramPollingStartRecoveryDecision> {
  return async () => {
    const ownersPath = deps.getOwnersPath();
    const statePaths = deps.getStatePaths();
    const classification = classifyTelegramRuntimeRecovery({
      ownersPath,
      statePaths,
    });
    if (classification.kind === "clean") return { kind: "unhandled" };
    if (classification.kind === "blocked-live-owner") {
      return {
        kind: "blocked",
        message: `Telegram temporary state is damaged, but owner process ${classification.livePids.join(", ")} is still live. Restart that Pi instance, then run /telegram-connect again.`,
      };
    }

    try {
      await deps.suspendPolling();
    } catch (error) {
      deps.recordRuntimeEvent?.("recovery", error, {
        phase: "suspend-before-reset",
      });
      return {
        kind: "blocked",
        message:
          "Telegram polling could not stop safely, so temporary state was not reset. Restart this Pi instance and run /telegram-connect again.",
      };
    }
    try {
      await deps.releaseOwnership?.();
    } catch (error) {
      deps.recordRuntimeEvent?.("recovery", error, {
        phase: "release-before-reset",
      });
    }
    try {
      const recovery = recoverTelegramRuntimeState({
        ownersPath,
        statePaths,
      });
      if (recovery.kind === "blocked-live-owner") {
        return {
          kind: "blocked",
          message: `Telegram temporary state changed during recovery and is now protected by owner process ${recovery.livePids.join(", ")}. Restart that Pi instance, then run /telegram-connect again.`,
        };
      }
      return {
        kind: "retry",
        message:
          recovery.kind === "recovered"
            ? "Telegram temporary state was damaged after an unclean shutdown and has been reset."
            : "Telegram temporary state was recovered by another Pi instance.",
      };
    } catch (error) {
      deps.recordRuntimeEvent?.("recovery", error, { phase: "runtime-reset" });
      return {
        kind: "blocked",
        message:
          "Telegram temporary-state recovery failed. Restart this Pi instance and run /telegram-connect again.",
      };
    }
  };
}
