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
export const TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS = 5_000;

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
  instanceId?: string;
  heartbeatMs?: number;
  leaderEpoch?: number;
  busSocketPath?: string;
  busSecret?: string;
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
  refresh: (ctx?: TelegramLockContext) => boolean;
}

export interface TelegramLockOwnershipGuard<
  TContext extends TelegramLockContext,
> {
  ownsContext: (ctx: TContext) => boolean;
}

export interface TelegramLockContextStore<
  TContext extends TelegramLockContext,
> {
  get: () => TContext | undefined;
}

export interface TelegramLockRuntimeOptions {
  key?: string;
  locksPath?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  instanceId?: string;
  busSocketPath?: string;
  busSecret?: string;
  getNowMs?: () => number;
  staleHeartbeatMs?: number;
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
    writeFileSync(tempPath, `${JSON.stringify(locks, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
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
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    heartbeatMs:
      typeof record.heartbeatMs === "number" ? record.heartbeatMs : undefined,
    leaderEpoch:
      typeof record.leaderEpoch === "number" ? record.leaderEpoch : undefined,
    busSocketPath:
      typeof record.busSocketPath === "string"
        ? record.busSocketPath
        : undefined,
    busSecret:
      typeof record.busSecret === "string" ? record.busSecret : undefined,
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

export function formatTelegramLockEntry(lock: TelegramLockEntry): string {
  return lock.cwd ? `pid ${lock.pid}, cwd ${lock.cwd}` : `pid ${lock.pid}`;
}

function getLockState(
  lock: TelegramLockEntry | undefined,
  pid: number,
  isAlive: (pid: number) => boolean,
  options: { nowMs?: number; staleHeartbeatMs?: number } = {},
): TelegramLockState {
  if (!lock) return { kind: "inactive" };
  if (lock.pid === pid) return { kind: "active-here", lock };
  if (
    typeof lock.heartbeatMs === "number" &&
    typeof options.nowMs === "number" &&
    typeof options.staleHeartbeatMs === "number" &&
    options.nowMs - lock.heartbeatMs > options.staleHeartbeatMs
  ) {
    return { kind: "stale", lock };
  }
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

function createLockEntry(
  pid: number,
  ctx: TelegramLockContext,
  options: {
    instanceId?: string;
    busSocketPath?: string;
    busSecret?: string;
    getNowMs?: () => number;
  },
): TelegramLockEntry {
  const lock: TelegramLockEntry = { pid, cwd: ctx.cwd };
  if (options.instanceId) {
    const nowMs = options.getNowMs?.();
    lock.instanceId = options.instanceId;
    lock.heartbeatMs = nowMs;
    lock.leaderEpoch = nowMs;
  }
  if (options.busSocketPath) lock.busSocketPath = options.busSocketPath;
  if (options.busSecret) lock.busSecret = options.busSecret;
  return lock;
}

function formatLockState(state: TelegramLockState): string {
  switch (state.kind) {
    case "inactive":
      return "inactive";
    case "active-here":
      return "active here";
    case "active-elsewhere":
      return `active elsewhere (${formatTelegramLockEntry(state.lock)})`;
    case "stale":
      return `stale (${formatTelegramLockEntry(state.lock)})`;
  }
}

export function createTelegramLockRuntime<TContext extends TelegramLockContext>(
  options: TelegramLockRuntimeOptions = {},
): TelegramLockRuntime<TContext> {
  const key = options.key ?? TELEGRAM_LOCK_KEY;
  const locksPath = options.locksPath ?? getLocksPath();
  const pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const getNowMs = options.getNowMs ?? Date.now;
  const stateOptions = () => ({
    nowMs: getNowMs(),
    staleHeartbeatMs: options.staleHeartbeatMs,
  });
  const readLock = () => parseTelegramLockEntry(readLocks(locksPath)[key]);
  const writeLock = (lock: TelegramLockEntry) => {
    const locks = readLocks(locksPath);
    locks[key] = lock;
    writeLocks(locksPath, locks);
  };
  return {
    acquire: (ctx, acquireOptions = {}) => {
      const state = getLockState(readLock(), pid, isAlive, stateOptions());
      if (state.kind === "active-elsewhere" && !acquireOptions.force)
        return { ok: false, lock: state.lock };
      const lock = createLockEntry(pid, ctx, {
        instanceId: options.instanceId,
        busSocketPath: options.busSocketPath,
        busSecret: options.busSecret,
        getNowMs,
      });
      writeLock(lock);
      return { ok: true, lock, replacedStale: state.kind === "stale" };
    },
    release: () => {
      const state = getLockState(readLock(), pid, isAlive, stateOptions());
      if (state.kind === "active-here" || state.kind === "stale") {
        const locks = readLocks(locksPath);
        delete locks[key];
        writeLocks(locksPath, locks);
      }
      return state;
    },
    getState: () => getLockState(readLock(), pid, isAlive, stateOptions()),
    getStatusLabel: () =>
      formatLockState(getLockState(readLock(), pid, isAlive, stateOptions())),
    owns: (ctx) => ownsLockContext(readLock(), pid, ctx),
    refresh: (ctx) => {
      const lock = readLock();
      if (!lock || !ownsLockContext(lock, pid, ctx)) return false;
      if (!options.instanceId) return true;
      writeLock({
        pid: lock.pid,
        ...(lock.cwd ? { cwd: lock.cwd } : {}),
        instanceId: options.instanceId,
        heartbeatMs: getNowMs(),
        leaderEpoch: lock.leaderEpoch,
        ...(options.busSocketPath
          ? { busSocketPath: options.busSocketPath }
          : {}),
        busSecret: options.busSecret ?? lock.busSecret,
      });
      return true;
    },
  };
}

export function createTelegramLockOwnershipGuard<
  TContext extends TelegramLockContext,
>(lock: TelegramLockRuntime<TContext>): TelegramLockOwnershipGuard<TContext> {
  return {
    ownsContext: (ctx) => lock.owns(ctx),
  };
}

export function createTelegramDirectDeliveryOwnershipChecker<
  TContext extends TelegramLockContext,
>(deps: {
  lock: TelegramLockRuntime<TContext>;
  contextStore: TelegramLockContextStore<TContext>;
}): () => boolean {
  return () => {
    const ctx = deps.contextStore.get();
    return ctx ? deps.lock.owns(ctx) : false;
  };
}

export interface TelegramLockedPollingStartOptions {
  force?: boolean;
  forceFreshLeaderThread?: boolean;
}

export type TelegramLockedPollingStartResult =
  | { ok: true; message?: string; canTakeover?: false }
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
  registerFollowerWithOwner?: (
    ctx: TContext,
    owner: TelegramLockEntry,
  ) => boolean | undefined | Promise<boolean | undefined>;
  stopFollowerRegistration?: () => void;
}

export interface TelegramLockedPollingRuntimeDeps<
  TContext extends TelegramLockContext,
> {
  lock: TelegramLockRuntime<TContext>;
  hasBotToken: () => boolean;
  canStartPolling?: (ctx: TContext) => boolean;
  formatStartBlockedMessage?: (ctx: TContext) => string;
  startPolling: (
    ctx: TContext,
    options?: TelegramLockedPollingStartOptions,
  ) => void | Promise<void>;
  stopPolling: () => Promise<void>;
  registerFollowerWithOwner?: (
    ctx: TContext,
    owner: TelegramLockEntry,
  ) => boolean | undefined | Promise<boolean | undefined>;
  stopFollowerRegistration?: () => void;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  ownershipCheckMs?: number;
}

function snapshotLockContext(ctx: TelegramLockContext): TelegramLockContext {
  return { cwd: ctx.cwd };
}

export function createTelegramLockedPollingRuntime<
  TContext extends TelegramLockContext,
>(
  deps: TelegramLockedPollingRuntimeDeps<TContext>,
): TelegramLockedPollingRuntime<TContext> {
  let ownershipInterval: ReturnType<typeof setInterval> | undefined;
  let ownershipStop: Promise<void> | undefined;
  let sessionAutoStartRun: Promise<void> | undefined;
  let sessionAutoStartGeneration = 0;
  const ownershipCheckMs = deps.ownershipCheckMs ?? 1000;
  const stopOwnershipWatcher = () => {
    if (!ownershipInterval) return;
    clearInterval(ownershipInterval);
    ownershipInterval = undefined;
  };
  const suspendPolling = async () => {
    sessionAutoStartGeneration += 1;
    deps.stopFollowerRegistration?.();
    stopOwnershipWatcher();
    if (sessionAutoStartRun) {
      await sessionAutoStartRun;
    }
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
      if (deps.lock.refresh(owner)) return;
      stopAfterOwnershipLoss();
    }, ownershipCheckMs);
    ownershipInterval.unref?.();
  };
  const canStartPolling = (ctx: TContext): boolean =>
    deps.canStartPolling?.(ctx) ?? true;
  const formatStartBlockedMessage = (ctx: TContext): string =>
    deps.formatStartBlockedMessage?.(ctx) ??
    "Telegram polling is unavailable in this Pi run mode.";
  return {
    start: async (ctx, options = {}) => {
      if (!deps.hasBotToken()) {
        return { ok: false, message: "Telegram bot is not configured." };
      }
      if (!canStartPolling(ctx)) {
        return { ok: false, message: formatStartBlockedMessage(ctx) };
      }
      const acquired = deps.lock.acquire(ctx, options);
      if (!acquired.ok) {
        if (deps.registerFollowerWithOwner) {
          let failureMessage: string | undefined;
          try {
            const registered = await deps.registerFollowerWithOwner(
              ctx,
              acquired.lock,
            );
            if (registered) {
              deps.updateStatus(ctx);
              return { ok: true, canTakeover: false };
            }
            if (registered === false) failureMessage = "not registered";
          } catch (error) {
            failureMessage =
              error instanceof Error ? error.message : String(error);
            deps.recordRuntimeEvent?.("bus", error, {
              phase: "follower-register",
            });
          }
          if (failureMessage) {
            const owner = formatTelegramLockEntry(acquired.lock);
            return {
              ok: false,
              canTakeover: false,
              owner,
              message: `Telegram bridge is active in another Pi instance (${owner}); follower registration failed: ${failureMessage}.`,
            };
          }
        }
        const owner = formatTelegramLockEntry(acquired.lock);
        return {
          ok: false,
          canTakeover: true,
          owner,
          message: `Telegram bridge is active in another Pi instance (${owner}).`,
        };
      }
      await deps.startPolling(ctx, options);
      startOwnershipWatcher(ctx);
      deps.updateStatus(ctx);
      const staleSuffix = acquired.replacedStale ? " Replaced stale lock." : "";
      return { ok: true, message: `Telegram bridge connected.${staleSuffix}` };
    },
    stop: async () => {
      await suspendPolling();
      const state = deps.lock.release();
      if (state.kind === "active-elsewhere") {
        return `Telegram bridge is active in another Pi instance (${formatTelegramLockEntry(state.lock)}).`;
      }
      if (state.kind === "stale") {
        return `Removed stale Telegram bridge lock (${formatTelegramLockEntry(state.lock)}).`;
      }
      return "Telegram bridge disconnected.";
    },
    suspend: suspendPolling,
    onSessionStart: async (_event, ctx) => {
      if (!deps.hasBotToken()) return;
      if (!canStartPolling(ctx)) return;
      const ownsCurrentLock = deps.lock.owns(ctx);
      const state = ownsCurrentLock ? undefined : deps.lock.getState();
      const canResumeStaleSameCwd =
        state?.kind === "stale" && state.lock.cwd === ctx.cwd;
      if (!ownsCurrentLock && !canResumeStaleSameCwd) return;
      sessionAutoStartGeneration += 1;
      const generation = sessionAutoStartGeneration;
      const startedAtMs = Date.now();
      deps.recordRuntimeEvent?.("lock", "Telegram auto-start scheduled", {
        phase: "auto-start-scheduled",
      });
      const run = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (generation !== sessionAutoStartGeneration) return;
        if (canResumeStaleSameCwd) {
          const acquired = deps.lock.acquire(ctx);
          if (!acquired.ok) return;
        }
        if (generation !== sessionAutoStartGeneration) return;
        await deps.startPolling(ctx);
        if (generation !== sessionAutoStartGeneration) return;
        startOwnershipWatcher(ctx);
        deps.updateStatus(ctx);
        deps.recordRuntimeEvent?.("lock", "Telegram auto-start completed", {
          phase: "auto-start-complete",
          durationMs: Date.now() - startedAtMs,
        });
      })()
        .catch((error) => {
          deps.recordRuntimeEvent?.("lock", error, { phase: "auto-start" });
        })
        .finally(() => {
          if (sessionAutoStartRun === run) sessionAutoStartRun = undefined;
        });
      sessionAutoStartRun = run;
    },
    registerFollowerWithOwner: deps.registerFollowerWithOwner
      ? async (ctx, owner) => {
          const registered = await deps.registerFollowerWithOwner?.(ctx, owner);
          if (registered) deps.updateStatus(ctx);
          return registered === true;
        }
      : undefined,
    stopFollowerRegistration: deps.stopFollowerRegistration,
  };
}
