/**
 * Telegram diagnostics logs
 * Zones: telegram diagnostics, filesystem, session observability
 * Owns bounded JSONL runtime evidence files, previous-log preservation, and profile-aware log paths without becoming routing state
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  resolveAgentDir,
  resolveTelegramProfileTempFilePath,
} from "./paths.ts";
import { withTelegramFileTransaction } from "./locks.ts";
import * as Status from "./status.ts";

export type TelegramLogPathInput = string | (() => string);

export interface TelegramRuntimeJsonlEvent {
  at: number;
  category: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TelegramRuntimeJsonlLogOptions {
  path?: TelegramLogPathInput;
  previousPath?: TelegramLogPathInput;
  maxBytes?: number;
  getNowMs?: () => number;
  canReset?: () => boolean;
  commitReset?: (commit: () => void) => boolean;
}

export interface TelegramRuntimeJsonlLog {
  getPath: () => string;
  reset: (reason: string, scope?: Record<string, unknown>) => void;
  resetIfScopeChanged: (
    scopeKey: string,
    reason: string,
    scope?: Record<string, unknown>,
  ) => void;
  record: (event: TelegramRuntimeJsonlEvent) => void;
}

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

export function getTelegramRuntimeLogPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveTelegramProfileTempFilePath(
    "logs",
    "jsonl",
    agentDir,
    profileName,
  );
}

export function getTelegramPreviousRuntimeLogPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveTelegramProfileTempFilePath(
    "logs",
    "_prev.jsonl",
    agentDir,
    profileName,
  );
}

function safeJsonLine(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Error) return item.message;
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "function" || typeof item === "symbol")
      return undefined;
    return item;
  });
}

export function createTelegramRuntimeJsonlLog(
  options: TelegramRuntimeJsonlLogOptions = {},
): TelegramRuntimeJsonlLog {
  const resolvePath = () =>
    typeof options.path === "function"
      ? options.path()
      : (options.path ?? getTelegramRuntimeLogPath());
  const resolvePreviousPath = () => {
    if (typeof options.previousPath === "function")
      return options.previousPath();
    if (options.previousPath) return options.previousPath;
    return resolvePath().replace(/\.jsonl$/u, "._prev.jsonl");
  };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const getNowMs = options.getNowMs ?? Date.now;
  const scopeKeys = new Map<string, string | undefined>();
  let pending: Promise<void> = Promise.resolve();
  let appendScheduled = false;
  let queuedAppends: {
    path: string;
    previousPath: string;
    line: string;
  }[] = [];

  const ensureParent = (path: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  };

  const preserveCurrentLog = (path: string, previousPath: string) => {
    if (!existsSync(path)) return;
    mkdirSync(dirname(previousPath), { recursive: true, mode: 0o700 });
    copyFileSync(path, previousPath);
  };

  const writeResetLocked = (
    path: string,
    previousPath: string,
    reason: string,
    scope?: Record<string, unknown>,
  ) => {
    ensureParent(path);
    preserveCurrentLog(path, previousPath);
    writeFileSync(
      path,
      safeJsonLine({
        at: getNowMs(),
        kind: "reset",
        reason,
        scope,
        previousPath,
      }) + "\n",
      { mode: 0o600 },
    );
  };

  const writeReset = (
    reason: string,
    scope?: Record<string, unknown>,
  ): boolean => {
    if (options.canReset && !options.canReset()) return false;
    const path = resolvePath();
    let didReset = false;
    withTelegramFileTransaction(`${path}.transaction`, () => {
      const commit = () => {
        writeResetLocked(path, resolvePreviousPath(), reason, scope);
        didReset = true;
      };
      if (options.commitReset) {
        options.commitReset(commit);
      } else {
        commit();
      }
    });
    return didReset;
  };

  const appendLine = (line: string) => {
    queuedAppends.push({
      path: resolvePath(),
      previousPath: resolvePreviousPath(),
      line,
    });
    if (appendScheduled) return;
    appendScheduled = true;
    pending = pending
      .then(() => {
        appendScheduled = false;
        const batch = queuedAppends;
        queuedAppends = [];
        const groups = new Map<
          string,
          { path: string; previousPath: string; lines: string[] }
        >();
        for (const entry of batch) {
          const key = `${entry.path}\u0000${entry.previousPath}`;
          const group = groups.get(key);
          if (group) group.lines.push(entry.line);
          else groups.set(key, { ...entry, lines: [entry.line] });
        }
        for (const group of groups.values()) {
          try {
            ensureParent(group.path);
            withTelegramFileTransaction(`${group.path}.transaction`, () => {
              let currentSize = existsSync(group.path)
                ? statSync(group.path).size
                : 0;
              let chunk = "";
              let chunkBytes = 0;
              const flushChunk = () => {
                if (!chunk) return;
                appendFileSync(group.path, chunk, { mode: 0o600 });
                currentSize += chunkBytes;
                chunk = "";
                chunkBytes = 0;
              };
              const rotate = (): boolean => {
                if (options.canReset && !options.canReset()) return false;
                let rotated = false;
                const commit = () => {
                  writeResetLocked(
                    group.path,
                    group.previousPath,
                    "max-bytes",
                    { maxBytes },
                  );
                  rotated = true;
                };
                if (options.commitReset) options.commitReset(commit);
                else commit();
                if (rotated) currentSize = statSync(group.path).size;
                return rotated;
              };
              for (const line of group.lines) {
                const lineBytes = Buffer.byteLength(line);
                if (
                  currentSize + chunkBytes > 0 &&
                  currentSize + chunkBytes + lineBytes > maxBytes
                ) {
                  flushChunk();
                  rotate();
                }
                chunk += line;
                chunkBytes += lineBytes;
              }
              flushChunk();
            });
          } catch {
            // Diagnostics failures for one profile must not drop other groups.
          }
        }
      })
      .catch(() => undefined);
  };

  return {
    getPath: resolvePath,
    reset(reason, scope) {
      const path = resolvePath();
      try {
        if (writeReset(reason, scope)) {
          scopeKeys.set(path, scope ? safeJsonLine(scope) : undefined);
        }
      } catch {
        // Diagnostics must never break Telegram runtime behavior.
      }
    },
    resetIfScopeChanged(nextScopeKey, reason, scope) {
      const path = resolvePath();
      if (scopeKeys.get(path) === nextScopeKey) return;
      try {
        if (writeReset(reason, scope)) scopeKeys.set(path, nextScopeKey);
      } catch {
        // Diagnostics must never break Telegram runtime behavior.
      }
    },
    record(event) {
      try {
        appendLine(safeJsonLine({ kind: "event", ...event }) + "\n");
      } catch {
        // Diagnostics must never break Telegram runtime behavior.
      }
    },
  };
}

export interface TelegramRuntimeDiagnosticsRuntime<TContext> {
  events: Status.TelegramRuntimeEventRecorder;
  recordRuntimeEvent(
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ): void;
  bindStorage(ports: {
    getBotToken(): string | undefined;
    getProfileName(): string | undefined;
    canReset(): boolean;
    commitReset(commit: () => void): boolean;
  }): void;
  bindStatus(ports: {
    instanceId: string;
    updateStatus(ctx: TContext, error?: string): void;
    getStatusState(): Status.TelegramBridgeStatusLineState;
    persistSnapshot(
      snapshot: ReturnType<typeof Status.createTelegramStatusSnapshot>,
    ): Promise<void>;
  }): void;
  updateStatus(ctx: TContext, error?: string): void;
  getStatusLines(options?: Status.TelegramBridgeStatusLineOptions): string[];
  scheduleSnapshotPersist(): void;
}

export function createTelegramRuntimeDiagnosticsRuntime<
  TContext,
>(): TelegramRuntimeDiagnosticsRuntime<TContext> {
  let getBotToken = (): string | undefined => undefined;
  let getProfileName = (): string | undefined => undefined;
  let canReset = (): boolean => false;
  let commitReset = (_commit: () => void): boolean => false;
  let statusPorts:
    | {
        instanceId: string;
        updateStatus(ctx: TContext, error?: string): void;
        getStatusState(): Status.TelegramBridgeStatusLineState;
        persistSnapshot(
          snapshot: ReturnType<typeof Status.createTelegramStatusSnapshot>,
        ): Promise<void>;
      }
    | undefined;
  let requestSnapshotPersist = (): void => {};
  const events = Status.createTelegramRuntimeEventRecorder({
    getBotToken: () => getBotToken(),
  });
  const jsonl = createTelegramRuntimeJsonlLog({
    path: () => getTelegramRuntimeLogPath(undefined, getProfileName()),
    previousPath: () =>
      getTelegramPreviousRuntimeLogPath(undefined, getProfileName()),
    canReset: () => canReset(),
    commitReset: (commit) => commitReset(commit),
  });
  const recordRuntimeEvent = function (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ): void {
    events.record(category, error, details);
    const latestEvent = events.getEvents().at(-1);
    if (latestEvent) jsonl.record(latestEvent);
    requestSnapshotPersist();
  };
  const persistCurrentSnapshot = async (): Promise<void> => {
    if (!statusPorts) return;
    await statusPorts.persistSnapshot(
      Status.createTelegramStatusSnapshot(statusPorts.getStatusState()),
    );
  };
  const updateRuntimeLogScope = function (reason: string): void {
    if (!statusPorts) return;
    const scope = Status.createTelegramRuntimeLogScope({
      state: statusPorts.getStatusState(),
      instanceId: statusPorts.instanceId,
    });
    jsonl.resetIfScopeChanged(JSON.stringify(scope), reason, scope);
  };
  return {
    events,
    recordRuntimeEvent,
    bindStorage(ports) {
      getBotToken = ports.getBotToken;
      getProfileName = ports.getProfileName;
      canReset = ports.canReset;
      commitReset = ports.commitReset;
    },
    bindStatus(ports) {
      statusPorts = ports;
      requestSnapshotPersist =
        Status.createTelegramRuntimeDiagnosticsSnapshotScheduler({
          persistSnapshot: persistCurrentSnapshot,
          recordError(error) {
            events.record("telegram", error, {
              phase: "runtime-diagnostics-snapshot-persist",
            });
          },
        });
    },
    updateStatus(ctx, error) {
      if (!statusPorts) return;
      statusPorts.updateStatus(ctx, error);
      updateRuntimeLogScope("status-scope-change");
    },
    getStatusLines(options) {
      if (!statusPorts) return [];
      void persistCurrentSnapshot().catch((error) => {
        recordRuntimeEvent("telegram", error, {
          phase: "status-snapshot-persist",
        });
      });
      return Status.buildTelegramBridgeStatusLines(
        statusPorts.getStatusState(),
        options,
      );
    },
    scheduleSnapshotPersist() {
      requestSnapshotPersist();
    },
  };
}
