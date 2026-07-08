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
  appendFile,
} from "node:fs";
import { dirname } from "node:path";
import {
  resolveAgentDir,
  resolveTelegramProfileTempFilePath,
} from "./paths.ts";

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
    "previous.jsonl",
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
    if (typeof options.previousPath === "function") return options.previousPath();
    if (options.previousPath) return options.previousPath;
    return resolvePath().replace(/\.jsonl$/u, ".previous.jsonl");
  };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const getNowMs = options.getNowMs ?? Date.now;
  const scopeKeys = new Map<string, string | undefined>();
  let pending: Promise<void> = Promise.resolve();

  const ensureParent = (path: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  };

  const preserveCurrentLog = (path: string, previousPath: string) => {
    if (!existsSync(path)) return;
    mkdirSync(dirname(previousPath), { recursive: true, mode: 0o700 });
    copyFileSync(path, previousPath);
  };

  const writeReset = (reason: string, scope?: Record<string, unknown>) => {
    const path = resolvePath();
    const previousPath = resolvePreviousPath();
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

  const appendLine = (line: string) => {
    pending = pending
      .catch(() => undefined)
      .then(async () => {
        const path = resolvePath();
        ensureParent(path);
        if (existsSync(path) && statSync(path).size > maxBytes) {
          writeReset("max-bytes", { maxBytes });
        }
        await new Promise<void>((resolve, reject) => {
          appendFile(path, line, { mode: 0o600 }, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      });
  };

  return {
    getPath: resolvePath,
    reset(reason, scope) {
      const path = resolvePath();
      scopeKeys.set(path, scope ? safeJsonLine(scope) : undefined);
      try {
        writeReset(reason, scope);
      } catch {
        // Diagnostics must never break Telegram runtime behavior.
      }
    },
    resetIfScopeChanged(nextScopeKey, reason, scope) {
      const path = resolvePath();
      if (scopeKeys.get(path) === nextScopeKey) return;
      scopeKeys.set(path, nextScopeKey);
      try {
        writeReset(reason, scope);
      } catch {
        // Diagnostics must never break Telegram runtime behavior.
      }
    },
    record(event) {
      appendLine(safeJsonLine({ kind: "event", ...event }) + "\n");
    },
  };
}
