/**
 * Telegram runtime JSONL diagnostics log
 * Zones: telegram diagnostics, filesystem, session observability
 * Owns session-local append-only runtime evidence for debugging without becoming routing state
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
  appendFile,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface TelegramRuntimeJsonlEvent {
  at: number;
  category: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TelegramRuntimeJsonlLogOptions {
  path?: string;
  previousPath?: string;
  maxBytes?: number;
  getNowMs?: () => number;
}

export interface TelegramRuntimeJsonlLog {
  path: string;
  reset: (reason: string, scope?: Record<string, unknown>) => void;
  resetIfScopeChanged: (
    scopeKey: string,
    reason: string,
    scope?: Record<string, unknown>,
  ) => void;
  record: (event: TelegramRuntimeJsonlEvent) => void;
}

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

export function getTelegramRuntimeLogPath(agentDir = getAgentDir()): string {
  return join(agentDir, "tmp", "telegram", "logs.jsonl");
}

function safeJsonLine(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Error) return item.message;
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "function" || typeof item === "symbol") return undefined;
    return item;
  });
}

export function createTelegramRuntimeJsonlLog(
  options: TelegramRuntimeJsonlLogOptions = {},
): TelegramRuntimeJsonlLog {
  const path = options.path ?? getTelegramRuntimeLogPath();
  const previousPath =
    options.previousPath ?? path.replace(/\.jsonl$/u, ".previous.jsonl");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const getNowMs = options.getNowMs ?? Date.now;
  let scopeKey: string | undefined;
  let pending: Promise<void> = Promise.resolve();

  const ensureParent = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  };

  const preserveCurrentLog = () => {
    if (!existsSync(path)) return;
    mkdirSync(dirname(previousPath), { recursive: true, mode: 0o700 });
    copyFileSync(path, previousPath);
  };

  const writeReset = (reason: string, scope?: Record<string, unknown>) => {
    ensureParent();
    preserveCurrentLog();
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
        ensureParent();
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
    path,
    reset(reason, scope) {
      scopeKey = scope ? safeJsonLine(scope) : undefined;
      try {
        writeReset(reason, scope);
      } catch {
        // Diagnostics must never break Telegram runtime behavior.
      }
    },
    resetIfScopeChanged(nextScopeKey, reason, scope) {
      if (scopeKey === nextScopeKey) return;
      scopeKey = nextScopeKey;
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
