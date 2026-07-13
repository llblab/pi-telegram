/**
 * Telegram singleton lock helpers
 * Zones: shared singleton, filesystem, telegram runtime ownership
 * Owns shared locks.json access and Telegram bridge ownership semantics
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { resolveTelegramLocksPath } from "./paths.ts";

export const TELEGRAM_LOCK_KEY = "@llblab/pi-telegram";
export const TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS = 5_000;
const TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS = 5;
const TELEGRAM_LOCK_WRITE_RETRY_DELAY_MS = 25;
const TELEGRAM_LOCK_TRANSACTION_ATTEMPTS = 80;
const TELEGRAM_LOCK_TRANSACTION_RETRY_DELAY_MS = 25;
const TELEGRAM_LOCK_RUNTIME_GENERATION_KEY =
  "__piTelegramLockRuntimeGeneration__";

function allocateTelegramLockRuntimeGeneration(): number {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals[TELEGRAM_LOCK_RUNTIME_GENERATION_KEY];
  const previousGeneration =
    typeof previous === "number" && Number.isSafeInteger(previous)
      ? previous
      : 0;
  const generation = Math.max(Date.now(), previousGeneration + 1);
  globals[TELEGRAM_LOCK_RUNTIME_GENERATION_KEY] = generation;
  return generation;
}

function getLocksPath(): string {
  return resolveTelegramLocksPath();
}

/**
 * Resolve the scoped lock key for the active Telegram profile.
 * Default profile → @llblab/pi-telegram
 * Named profile → @llblab/pi-telegram:<name>
 */
export function resolveTelegramLockKey(activeProfile?: string): string {
  if (activeProfile) return `${TELEGRAM_LOCK_KEY}:${activeProfile}`;
  return TELEGRAM_LOCK_KEY;
}

export interface TelegramActiveProfileGetter {
  getActiveProfileName: () => string | undefined;
}

export function createTelegramLockKeyResolver(
  activeProfile: TelegramActiveProfileGetter,
): () => string {
  return function getTelegramLockKey() {
    return resolveTelegramLockKey(activeProfile.getActiveProfileName());
  };
}

export interface TelegramLockEntry {
  pid: number;
  cwd?: string;
  instanceId?: string;
  heartbeatMs?: number;
  leaderEpoch?: number | string;
  runtimeGeneration?: number;
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
  expectedOwner?: TelegramLockEntry;
  election?: boolean;
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
  getOwnedLeaderEpoch: () => number | string | undefined;
  owns: (ctx?: TelegramLockContext) => boolean;
  commitIfOwned: (commit: () => void) => boolean;
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
  key?: string | (() => string | undefined);
  locksPath?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  instanceId?: string;
  busSocketPath?: string;
  busSecret?: string;
  getNowMs?: () => number;
  mintLeaderEpoch?: () => number | string;
  runtimeGeneration?: number;
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

function readLocksForTransaction(path: string): Record<string, unknown> {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Telegram lock registry: ${path}`);
  }
  return value as Record<string, unknown>;
}

function isRetryableLockWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

interface TelegramLockTransactionOwner {
  pid: number;
  acquiredAtMs: number;
  generation: string;
}

function readLockTransactionOwner(
  path: string,
): TelegramLockTransactionOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof value.pid !== "number" ||
      typeof value.acquiredAtMs !== "number" ||
      typeof value.generation !== "string"
    ) {
      return undefined;
    }
    return {
      pid: value.pid,
      acquiredAtMs: value.acquiredAtMs,
      generation: value.generation,
    };
  } catch {
    return undefined;
  }
}

function createLockTransactionGuard(
  path: string,
): TelegramLockTransactionOwner {
  const owner: TelegramLockTransactionOwner = {
    pid: process.pid,
    acquiredAtMs: Date.now(),
    generation: randomUUID(),
  };
  const stagedPath = `${path}.${owner.generation}.tmp`;
  try {
    writeFileSync(stagedPath, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    linkSync(stagedPath, path);
    return owner;
  } finally {
    try {
      unlinkSync(stagedPath);
    } catch {
      /* best effort */
    }
  }
}

function releaseLockTransactionGuard(
  path: string,
  owner: TelegramLockTransactionOwner,
): void {
  const current = readLockTransactionOwner(path);
  if (!current) {
    if (!existsSync(path)) return;
    throw new Error(`Cannot verify Telegram lock transaction guard: ${path}`);
  }
  if (
    current.pid !== owner.pid ||
    current.generation !== owner.generation ||
    current.acquiredAtMs !== owner.acquiredAtMs
  ) {
    throw new Error(
      `Telegram lock transaction guard changed ownership: ${path}`,
    );
  }
  for (
    let attempt = 0;
    attempt < TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    try {
      unlinkSync(path);
      return;
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return;
      if (
        !isRetryableLockWriteError(error) ||
        attempt === TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      sleepSync(TELEGRAM_LOCK_WRITE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function isAbandonedLockTransaction(path: string): boolean {
  const owner = readLockTransactionOwner(path);
  return owner ? !isProcessAlive(owner.pid) : false;
}

function recoverAbandonedLockTransaction(
  path: string,
): TelegramLockTransactionOwner | undefined {
  if (!isAbandonedLockTransaction(path)) return undefined;
  const recoveryGuardPath = `${path}.recovery`;
  let recoveryOwner: TelegramLockTransactionOwner;
  try {
    recoveryOwner = createLockTransactionGuard(recoveryGuardPath);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "EEXIST") return undefined;
    throw error;
  }
  let recoveredOwner: TelegramLockTransactionOwner | undefined;
  try {
    if (!isAbandonedLockTransaction(path)) return undefined;
    const stalePath = `${path}.stale.${process.pid}.${Date.now()}`;
    try {
      renameSync(path, stalePath);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      unlinkSync(stalePath);
    } catch {
      /* best effort */
    }
    try {
      recoveredOwner = createLockTransactionGuard(path);
      return recoveredOwner;
    } catch (error) {
      if ((error as { code?: unknown })?.code === "EEXIST") return undefined;
      throw error;
    }
  } finally {
    try {
      releaseLockTransactionGuard(recoveryGuardPath, recoveryOwner);
    } catch (error) {
      if (recoveredOwner) {
        try {
          releaseLockTransactionGuard(path, recoveredOwner);
        } catch {
          /* preserve the recovery cleanup failure */
        }
      }
      throw error;
    }
  }
}

function acquireLockTransaction(path: string): TelegramLockTransactionOwner {
  mkdirSync(dirname(path), { recursive: true });
  for (
    let attempt = 0;
    attempt < TELEGRAM_LOCK_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return createLockTransactionGuard(path);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "EEXIST") throw error;
      const recoveredOwner = recoverAbandonedLockTransaction(path);
      if (recoveredOwner !== undefined) return recoveredOwner;
      if (attempt === TELEGRAM_LOCK_TRANSACTION_ATTEMPTS - 1) {
        throw new Error(
          `Timed out acquiring Telegram lock transaction: ${path}`,
        );
      }
      sleepSync(TELEGRAM_LOCK_TRANSACTION_RETRY_DELAY_MS);
    }
  }
  throw new Error(`Failed to acquire Telegram lock transaction: ${path}`);
}

export function withTelegramFileTransaction<T>(
  transactionPath: string,
  operation: () => T,
): T {
  const owner = acquireLockTransaction(transactionPath);
  try {
    return operation();
  } finally {
    releaseLockTransactionGuard(transactionPath, owner);
  }
}

function withLockTransaction<T>(
  locksPath: string,
  mutate: (locks: Record<string, unknown>) => {
    result: T;
    changed: boolean;
  },
): T {
  return withTelegramFileTransaction(`${locksPath}.transaction`, () => {
    const locks = readLocksForTransaction(locksPath);
    const outcome = mutate(locks);
    if (outcome.changed) writeLocks(locksPath, locks);
    return outcome.result;
  });
}

export function writeLocks(path: string, locks: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(locks, null, 2)}\n`;
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    const tempPath = `${path}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      writeFileSync(tempPath, payload, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      try {
        unlinkSync(tempPath);
      } catch {
        /* best effort */
      }
      if (
        !isRetryableLockWriteError(error) ||
        attempt === TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      sleepSync(TELEGRAM_LOCK_WRITE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
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
      typeof record.leaderEpoch === "number" ||
      typeof record.leaderEpoch === "string"
        ? record.leaderEpoch
        : undefined,
    runtimeGeneration:
      typeof record.runtimeGeneration === "number"
        ? record.runtimeGeneration
        : undefined,
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

function formatTelegramFollowerRegistrationFailure(message: string): string {
  if (/\b(?:ENOENT|ECONNREFUSED|ETIMEDOUT)\b/u.test(message)) {
    return (
      `live owner / unreachable bus endpoint after bounded retries (${message}); ` +
      "wait briefly for owner recovery, then retry /telegram-connect. " +
      "Do not force takeover while the owner remains live"
    );
  }
  return message;
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

function hasSameLockOwner(
  current: TelegramLockEntry | undefined,
  expected: TelegramLockEntry | undefined,
): boolean {
  if (!current || !expected) return false;
  return (
    current.pid === expected.pid &&
    current.cwd === expected.cwd &&
    current.instanceId === expected.instanceId &&
    current.leaderEpoch === expected.leaderEpoch &&
    current.runtimeGeneration === expected.runtimeGeneration
  );
}

function canSupersedeSameProcessOwner(
  current: TelegramLockEntry,
  pid: number,
  ctx: TelegramLockContext,
  instanceId: string | undefined,
  runtimeGeneration: number,
): boolean {
  if (
    current.pid !== pid ||
    (current.cwd !== undefined && current.cwd !== ctx.cwd) ||
    !instanceId
  ) {
    return false;
  }
  return (
    current.runtimeGeneration === undefined ||
    runtimeGeneration > current.runtimeGeneration
  );
}

function createLockEntry(
  pid: number,
  ctx: TelegramLockContext,
  options: {
    instanceId?: string;
    busSocketPath?: string;
    busSecret?: string;
    getNowMs?: () => number;
    mintLeaderEpoch?: () => number | string;
    runtimeGeneration?: number;
  },
): TelegramLockEntry {
  const lock: TelegramLockEntry = { pid, cwd: ctx.cwd };
  if (options.instanceId) {
    const nowMs = options.getNowMs?.();
    lock.instanceId = options.instanceId;
    lock.heartbeatMs = nowMs;
    lock.leaderEpoch = options.mintLeaderEpoch?.() ?? randomUUID();
    lock.runtimeGeneration = options.runtimeGeneration;
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
  const runtimeGeneration =
    options.runtimeGeneration ?? allocateTelegramLockRuntimeGeneration();
  let ownedLockKey: string | undefined;
  let ownedLock: TelegramLockEntry | undefined;
  const stateOptions = () => ({
    nowMs: getNowMs(),
    staleHeartbeatMs: options.staleHeartbeatMs,
  });
  const resolveEffectiveKey = (): string => {
    if (typeof key === "function") return key() || TELEGRAM_LOCK_KEY;
    return key;
  };
  const readLock = () => {
    const effectiveKey = resolveEffectiveKey();
    return parseTelegramLockEntry(readLocks(locksPath)[effectiveKey]);
  };
  const adoptCompatibleOwnedLock = (
    effectiveKey: string,
    lock: TelegramLockEntry | undefined,
    ctx?: TelegramLockContext,
  ): TelegramLockEntry | undefined => {
    if (ownedLock) {
      return ownedLockKey === effectiveKey ? ownedLock : undefined;
    }
    if (!ownsLockContext(lock, pid, ctx)) return undefined;
    if (
      (lock?.instanceId !== undefined &&
        lock.instanceId !== options.instanceId) ||
      (lock?.runtimeGeneration !== undefined &&
        lock.runtimeGeneration !== runtimeGeneration)
    ) {
      return undefined;
    }
    ownedLockKey = effectiveKey;
    ownedLock = lock;
    return ownedLock;
  };
  return {
    acquire: (ctx, acquireOptions = {}) =>
      withLockTransaction<TelegramLockAcquireResult>(locksPath, (locks) => {
        const effectiveKey = resolveEffectiveKey();
        const current = parseTelegramLockEntry(locks[effectiveKey]);
        const state = getLockState(current, pid, isAlive, stateOptions());
        const expectedOwned = adoptCompatibleOwnedLock(
          effectiveKey,
          current,
          ctx,
        );
        if (
          state.kind === "active-here" &&
          hasSameLockOwner(current, expectedOwned)
        ) {
          return {
            result: {
              ok: true,
              lock: current!,
              replacedStale: false,
            } as const,
            changed: false,
          };
        }
        if (acquireOptions.election && current) {
          if (
            state.kind !== "stale" ||
            !hasSameLockOwner(current, acquireOptions.expectedOwner)
          ) {
            return {
              result: { ok: false, lock: current } as const,
              changed: false,
            };
          }
        }
        const expectedReplacementMatches = hasSameLockOwner(
          state.kind === "active-here" || state.kind === "active-elsewhere"
            ? state.lock
            : undefined,
          acquireOptions.expectedOwner,
        );
        const canReplaceCurrent =
          state.kind === "active-elsewhere" ||
          (state.kind === "active-here" &&
            canSupersedeSameProcessOwner(
              state.lock,
              pid,
              ctx,
              options.instanceId,
              runtimeGeneration,
            ));
        if (
          !acquireOptions.election &&
          (state.kind === "active-here" || state.kind === "active-elsewhere") &&
          (!acquireOptions.force ||
            !expectedReplacementMatches ||
            !canReplaceCurrent)
        ) {
          return {
            result: { ok: false, lock: state.lock } as const,
            changed: false,
          };
        }
        const lock = createLockEntry(pid, ctx, {
          instanceId: options.instanceId,
          busSocketPath: options.busSocketPath,
          busSecret: options.busSecret,
          getNowMs,
          mintLeaderEpoch: options.mintLeaderEpoch,
          runtimeGeneration,
        });
        locks[effectiveKey] = lock;
        ownedLockKey = effectiveKey;
        ownedLock = lock;
        return {
          result: {
            ok: true,
            lock,
            replacedStale: state.kind === "stale",
          } as const,
          changed: true,
        };
      }),
    release: () =>
      withLockTransaction(locksPath, (locks) => {
        const effectiveKey = resolveEffectiveKey();
        const state = getLockState(
          parseTelegramLockEntry(locks[effectiveKey]),
          pid,
          isAlive,
          stateOptions(),
        );
        const changed =
          ownedLockKey === effectiveKey &&
          hasSameLockOwner(
            parseTelegramLockEntry(locks[effectiveKey]),
            ownedLock,
          );
        if (changed) {
          delete locks[effectiveKey];
          ownedLockKey = undefined;
          ownedLock = undefined;
        }
        return { result: state, changed };
      }),
    getState: () => getLockState(readLock(), pid, isAlive, stateOptions()),
    getStatusLabel: () =>
      formatLockState(getLockState(readLock(), pid, isAlive, stateOptions())),
    getOwnedLeaderEpoch: () => {
      const effectiveKey = resolveEffectiveKey();
      const lock = parseTelegramLockEntry(readLocks(locksPath)[effectiveKey]);
      const exactOwner = adoptCompatibleOwnedLock(effectiveKey, lock);
      return hasSameLockOwner(lock, exactOwner) ? lock?.leaderEpoch : undefined;
    },
    owns: (ctx) => {
      const effectiveKey = resolveEffectiveKey();
      const lock = parseTelegramLockEntry(readLocks(locksPath)[effectiveKey]);
      return hasSameLockOwner(
        lock,
        adoptCompatibleOwnedLock(effectiveKey, lock, ctx),
      );
    },
    commitIfOwned: (commit) =>
      withLockTransaction(locksPath, (locks) => {
        const effectiveKey = resolveEffectiveKey();
        const lock = parseTelegramLockEntry(locks[effectiveKey]);
        const exactOwner =
          ownedLockKey === effectiveKey && hasSameLockOwner(lock, ownedLock);
        if (!exactOwner) {
          if (ownedLockKey === effectiveKey) {
            ownedLockKey = undefined;
            ownedLock = undefined;
          }
          return { result: false, changed: false };
        }
        commit();
        return { result: true, changed: false };
      }),
    refresh: (ctx) =>
      withLockTransaction(locksPath, (locks) => {
        const effectiveKey = resolveEffectiveKey();
        const lock = parseTelegramLockEntry(locks[effectiveKey]);
        const expectedOwner = adoptCompatibleOwnedLock(effectiveKey, lock, ctx);
        if (!lock || !hasSameLockOwner(lock, expectedOwner)) {
          if (ownedLockKey === effectiveKey) {
            ownedLockKey = undefined;
            ownedLock = undefined;
          }
          return { result: false, changed: false };
        }
        if (!options.instanceId) return { result: true, changed: false };
        const refreshedLock: TelegramLockEntry = {
          pid: lock.pid,
          ...(lock.cwd ? { cwd: lock.cwd } : {}),
          instanceId: options.instanceId,
          heartbeatMs: getNowMs(),
          leaderEpoch:
            lock.leaderEpoch ?? options.mintLeaderEpoch?.() ?? randomUUID(),
          runtimeGeneration: lock.runtimeGeneration ?? runtimeGeneration,
          ...(options.busSocketPath
            ? { busSocketPath: options.busSocketPath }
            : {}),
          busSecret: options.busSecret ?? lock.busSecret,
        };
        locks[effectiveKey] = refreshedLock;
        ownedLockKey = effectiveKey;
        ownedLock = refreshedLock;
        return { result: true, changed: true };
      }),
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
  election?: { expectedOwner?: TelegramLockEntry };
  onAcquired?: () => Promise<void> | void;
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
  let takeoverCandidate: TelegramLockEntry | undefined;
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
      try {
        if (deps.lock.refresh(owner)) return;
      } catch (error) {
        deps.recordRuntimeEvent?.("lock", error, { phase: "refresh" });
      }
      stopAfterOwnershipLoss();
    }, ownershipCheckMs);
    ownershipInterval.unref?.();
  };
  const runOwnedPollingStart = async (
    ctx: TContext,
    options: TelegramLockedPollingStartOptions,
  ): Promise<boolean> => {
    startOwnershipWatcher(ctx);
    try {
      if (!deps.lock.refresh(snapshotLockContext(ctx))) {
        stopOwnershipWatcher();
        return false;
      }
      await options.onAcquired?.();
      await deps.startPolling(ctx, options);
    } catch (error) {
      stopOwnershipWatcher();
      try {
        await deps.stopPolling();
      } catch (stopError) {
        deps.recordRuntimeEvent?.("lock", stopError, {
          phase: "startup-rollback",
        });
      }
      deps.lock.release();
      throw error;
    }
    if (deps.lock.owns(ctx)) return true;
    stopOwnershipWatcher();
    if (ownershipStop) await ownershipStop;
    await deps.stopPolling();
    return false;
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
      let acquired = deps.lock.acquire(ctx, {
        force: options.force,
        expectedOwner:
          options.election?.expectedOwner ??
          (options.force ? takeoverCandidate : undefined),
        election: options.election !== undefined,
      });
      if (!acquired.ok && !options.election) {
        const currentState = deps.lock.getState();
        if (
          currentState.kind === "active-here" &&
          hasSameLockOwner(currentState.lock, acquired.lock)
        ) {
          acquired = deps.lock.acquire(ctx, {
            force: true,
            expectedOwner: acquired.lock,
          });
        }
      }
      if (!acquired.ok) {
        takeoverCandidate = acquired.lock;
        if (options.election) {
          return {
            ok: false,
            canTakeover: false,
            owner: formatTelegramLockEntry(acquired.lock),
            message: "Telegram leadership election lost to another live owner.",
          };
        }
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
              message: `Telegram bridge is active in another Pi instance (${owner}); follower registration failed: ${formatTelegramFollowerRegistrationFailure(failureMessage)}.`,
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
      takeoverCandidate = undefined;
      if (!(await runOwnedPollingStart(ctx, options))) {
        return {
          ok: false,
          canTakeover: false,
          message: "Telegram leadership changed during polling startup.",
        };
      }
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
      const canHandoffSameProcess =
        state?.kind === "active-here" &&
        (!state.lock.cwd || state.lock.cwd === ctx.cwd);
      if (
        !ownsCurrentLock &&
        !canResumeStaleSameCwd &&
        !canHandoffSameProcess
      ) {
        return;
      }
      sessionAutoStartGeneration += 1;
      const generation = sessionAutoStartGeneration;
      const startedAtMs = Date.now();
      deps.recordRuntimeEvent?.("lock", "Telegram auto-start scheduled", {
        phase: "auto-start-scheduled",
      });
      const run = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (generation !== sessionAutoStartGeneration) return;
        if (canResumeStaleSameCwd || canHandoffSameProcess) {
          const acquired = deps.lock.acquire(
            ctx,
            canHandoffSameProcess
              ? { force: true, expectedOwner: state?.lock }
              : undefined,
          );
          if (!acquired.ok) return;
        }
        if (generation !== sessionAutoStartGeneration) return;
        if (!(await runOwnedPollingStart(ctx, {}))) return;
        if (generation !== sessionAutoStartGeneration) return;
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
