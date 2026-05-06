/**
 * Telegram singleton lock helpers
 * Zones: shared singleton, filesystem, telegram runtime ownership
 * Owns shared locks.json access and Telegram bridge ownership semantics
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TELEGRAM_LOCK_KEY = "@llblab/pi-telegram";

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

function getLocksPath(): string {
  return join(getAgentDir(), "locks.json");
}

export interface TelegramLockEntry {
  pid: number;
  cwd?: string;
}

export interface TelegramLockContext {
  cwd: string;
}

export type TelegramLockState =
  | { kind: "inactive" }
  | { kind: "active-here"; lock: TelegramLockEntry }
  | { kind: "active-elsewhere"; lock: TelegramLockEntry }
  | { kind: "stale"; lock: TelegramLockEntry };

export interface TelegramLockAcquireOptions {
  force?: boolean;
}

export type TelegramLockAcquireResult =
  | { ok: true; lock: TelegramLockEntry; replacedStale: boolean }
  | { ok: false; lock: TelegramLockEntry };

export interface TelegramLockRuntime<TContext extends TelegramLockContext> {
  acquire: (
    ctx: TContext,
    options?: TelegramLockAcquireOptions,
  ) => TelegramLockAcquireResult;
  release: () => TelegramLockState;
  getState: () => TelegramLockState;
  getStatusLabel: () => string;
  owns: (ctx?: TelegramLockContext) => boolean;
}

export interface TelegramLockOwnershipGuard<TContext extends TelegramLockContext> {
  ownsCurrentProcess: () => boolean;
  ownsContext: (ctx: TContext) => boolean;
}

export interface TelegramLockRuntimeOptions {
  key?: string;
  locksPath?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface TelegramLockedPollingStartOptions {
  force?: boolean;
}

export type TelegramLockedPollingStartResult =
  | { ok: true; message: string; canTakeover?: false }
  | { ok: false; message: string; canTakeover?: boolean; owner?: string };

export interface TelegramLockedPollingRuntime<
  TContext extends TelegramLockContext,
> {
  start: (
    ctx: TContext,
    options?: TelegramLockedPollingStartOptions,
  ) => Promise<TelegramLockedPollingStartResult>;
  stop: () => Promise<string>;
  suspend: () => Promise<void>;
  onSessionStart: (_event: unknown, ctx: TContext) => Promise<void>;
}

export interface TelegramLockedPollingRuntimeDeps<
  TContext extends TelegramLockContext,
> {
  lock: TelegramLockRuntime<TContext>;
  hasBotToken: () => boolean;
  startPolling: (ctx: TContext) => void | Promise<void>;
  stopPolling: () => Promise<void>;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  ownershipCheckMs?: number;
}

export function readLocks(path = getLocksPath()): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function writeLocks(path: string, locks: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(locks, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function parseTelegramLockEntry(
  value: unknown,
): TelegramLockEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== "number") return undefined;
  return {
    pid: record.pid,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
  };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function formatLock(lock: TelegramLockEntry): string {
  return lock.cwd ? `pid ${lock.pid}, cwd ${lock.cwd}` : `pid ${lock.pid}`;
}

function getLockState(
  lock: TelegramLockEntry | undefined,
  pid: number,
  isAlive: (pid: number) => boolean,
): TelegramLockState {
  if (!lock) return { kind: "inactive" };
  if (lock.pid === pid) return { kind: "active-here", lock };
  if (isAlive(lock.pid)) return { kind: "active-elsewhere", lock };
  return { kind: "stale", lock };
}

function ownsLockContext(
  lock: TelegramLockEntry | undefined,
  pid: number,
  ctx?: TelegramLockContext,
): boolean {
  if (!lock || lock.pid !== pid) return false;
  return !lock.cwd || !ctx || lock.cwd === ctx.cwd;
}

function snapshotLockContext(ctx: TelegramLockContext): TelegramLockContext {
  return { cwd: ctx.cwd };
}

function formatLockState(state: TelegramLockState): string {
  switch (state.kind) {
    case "inactive":
      return "inactive";
    case "active-here":
      return "active here";
    case "active-elsewhere":
      return `active elsewhere (${formatLock(state.lock)})`;
    case "stale":
      return `stale (${formatLock(state.lock)})`;
  }
}

export function createTelegramLockRuntime<TContext extends TelegramLockContext>(
  options: TelegramLockRuntimeOptions = {},
): TelegramLockRuntime<TContext> {
  const key = options.key ?? TELEGRAM_LOCK_KEY;
  const locksPath = options.locksPath ?? getLocksPath();
  const pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const readLock = () => parseTelegramLockEntry(readLocks(locksPath)[key]);
  const writeLock = (lock: TelegramLockEntry) => {
    const locks = readLocks(locksPath);
    locks[key] = lock;
    writeLocks(locksPath, locks);
  };
  return {
    acquire: (ctx, acquireOptions = {}) => {
      const state = getLockState(readLock(), pid, isAlive);
      if (state.kind === "active-elsewhere" && !acquireOptions.force)
        return { ok: false, lock: state.lock };
      const lock = { pid, cwd: ctx.cwd };
      writeLock(lock);
      return { ok: true, lock, replacedStale: state.kind === "stale" };
    },
    release: () => {
      const state = getLockState(readLock(), pid, isAlive);
      if (state.kind === "active-here" || state.kind === "stale") {
        const locks = readLocks(locksPath);
        delete locks[key];
        writeLocks(locksPath, locks);
      }
      return state;
    },
    getState: () => getLockState(readLock(), pid, isAlive),
    getStatusLabel: () =>
      formatLockState(getLockState(readLock(), pid, isAlive)),
    owns: (ctx) => ownsLockContext(readLock(), pid, ctx),
  };
}

export function createTelegramLockOwnershipGuard<
  TContext extends TelegramLockContext,
>(
  lock: TelegramLockRuntime<TContext>,
): TelegramLockOwnershipGuard<TContext> {
  return {
    ownsCurrentProcess: () => lock.owns(),
    ownsContext: (ctx) => lock.owns(ctx),
  };
}

export function createTelegramLockedPollingRuntime<
  TContext extends TelegramLockContext,
>(
  deps: TelegramLockedPollingRuntimeDeps<TContext>,
): TelegramLockedPollingRuntime<TContext> {
  let ownershipInterval: ReturnType<typeof setInterval> | undefined;
  let ownershipStop: Promise<void> | undefined;
  const ownershipCheckMs = deps.ownershipCheckMs ?? 1000;
  const stopOwnershipWatcher = () => {
    if (!ownershipInterval) return;
    clearInterval(ownershipInterval);
    ownershipInterval = undefined;
  };
  const suspendPolling = async () => {
    stopOwnershipWatcher();
    if (ownershipStop) {
      await ownershipStop;
      return;
    }
    await deps.stopPolling();
  };
  const stopAfterOwnershipLoss = () => {
    if (ownershipStop) return;
    stopOwnershipWatcher();
    ownershipStop = deps
      .stopPolling()
      .catch((error) =>
        deps.recordRuntimeEvent?.("lock", error, { phase: "ownership-loss" }),
      )
      .finally(() => {
        ownershipStop = undefined;
      });
  };
  const startOwnershipWatcher = (ctx: TContext) => {
    const owner = snapshotLockContext(ctx);
    stopOwnershipWatcher();
    ownershipInterval = setInterval(() => {
      if (deps.lock.owns(owner)) return;
      stopAfterOwnershipLoss();
    }, ownershipCheckMs);
    ownershipInterval.unref?.();
  };
  return {
    start: async (ctx, options = {}) => {
      if (!deps.hasBotToken())
        return { ok: false, message: "Telegram bot is not configured." };
      const acquired = deps.lock.acquire(ctx, options);
      if (!acquired.ok) {
        return {
          ok: false,
          canTakeover: true,
          owner: formatLock(acquired.lock),
          message: `Telegram bridge is active in another π instance (${formatLock(acquired.lock)}).`,
        };
      }
      await deps.startPolling(ctx);
      startOwnershipWatcher(ctx);
      deps.updateStatus(ctx);
      const staleSuffix = acquired.replacedStale ? " Replaced stale lock." : "";
      return { ok: true, message: `Telegram bridge connected.${staleSuffix}` };
    },
    stop: async () => {
      await suspendPolling();
      const state = deps.lock.release();
      if (state.kind === "active-elsewhere") {
        return `Telegram bridge is active in another π instance (${formatLock(state.lock)}).`;
      }
      if (state.kind === "stale")
        return `Removed stale Telegram bridge lock (${formatLock(state.lock)}).`;
      return "Telegram bridge disconnected.";
    },
    suspend: suspendPolling,
    onSessionStart: async (_event, ctx) => {
      if (!deps.hasBotToken()) return;
      const ownsCurrentLock = deps.lock.owns(ctx);
      const state = ownsCurrentLock ? undefined : deps.lock.getState();
      const canResumeStaleSameCwd =
        state?.kind === "stale" && state.lock.cwd === ctx.cwd;
      if (!ownsCurrentLock && !canResumeStaleSameCwd) return;
      try {
        if (canResumeStaleSameCwd) {
          const acquired = deps.lock.acquire(ctx);
          if (!acquired.ok) return;
        }
        await deps.startPolling(ctx);
        startOwnershipWatcher(ctx);
        deps.updateStatus(ctx);
      } catch (error) {
        deps.recordRuntimeEvent?.("lock", error, { phase: "auto-start" });
      }
    },
  };
}
