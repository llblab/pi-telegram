/**
 * Telegram singleton lock helpers
 * Zones: telegram ownership, filesystem, transport authority
 * Owns extension-local owners.json access and Telegram bridge ownership semantics
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { resolveTelegramOwnersPath } from "./paths.ts";

export const TELEGRAM_LOCK_KEY = "default";
export const TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS = 8_000;
const TELEGRAM_OWNERSHIP_REFRESH_MS = 2_000;
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

function getOwnersPath(): string {
  return resolveTelegramOwnersPath();
}

/**
 * Resolve the extension-local owner slot for the active Telegram profile.
 * Default profile → default
 * Named profile → the validated profile name
 */
export function resolveTelegramLockKey(activeProfile?: string): string {
  return activeProfile || TELEGRAM_LOCK_KEY;
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

export function readLocks(path = getOwnersPath()): Record<string, unknown> {
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
    throw new Error(`Invalid Telegram owner store: ${path}`);
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

const TELEGRAM_TRANSACTION_OWNER_PATTERN = /^owner\.([A-Za-z0-9-]+)\.json$/u;

function getLockTransactionOwnerFile(generation: string): string {
  return `owner.${generation}.json`;
}

function getLockTransactionOwnerPath(path: string): string {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    const entries = readdirSync(path);
    if (
      entries.length === 1 &&
      (TELEGRAM_TRANSACTION_OWNER_PATTERN.test(entries[0]) ||
        TELEGRAM_TRANSACTION_RECLAIM_PATTERN.test(entries[0]))
    ) {
      return join(path, entries[0]);
    }
    throw new Error(`Unverifiable Telegram lock transaction guard: ${path}`);
  }
  if (stat.isFile()) return path;
  throw new Error(`Unsupported Telegram lock transaction guard: ${path}`);
}

function readLockTransactionOwner(
  path: string,
): TelegramLockTransactionOwner | undefined {
  try {
    const value = JSON.parse(
      readFileSync(getLockTransactionOwnerPath(path), "utf8"),
    ) as Record<string, unknown>;
    if (
      typeof value.pid !== "number" ||
      typeof value.acquiredAtMs !== "number" ||
      typeof value.generation !== "string"
    ) {
      return undefined;
    }
    const ownerMatch = TELEGRAM_TRANSACTION_OWNER_PATTERN.exec(
      basename(getLockTransactionOwnerPath(path)),
    );
    if (ownerMatch && ownerMatch[1] !== value.generation) return undefined;
    return {
      pid: value.pid,
      acquiredAtMs: value.acquiredAtMs,
      generation: value.generation,
    };
  } catch {
    return undefined;
  }
}

function createLockTransactionContentionError(path: string): Error {
  return Object.assign(
    new Error(`Telegram lock transaction guard already exists: ${path}`),
    { code: "EEXIST" },
  );
}

function isLockTransactionContentionError(
  error: unknown,
  path: string,
): boolean {
  const code = (error as { code?: unknown })?.code;
  if (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    code === "ENOTDIR" ||
    code === "EISDIR"
  ) {
    return true;
  }
  return existsSync(path) && (code === "EPERM" || code === "EACCES");
}

function removeLockTransactionGuard(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function createLockTransactionGuard(
  path: string,
): TelegramLockTransactionOwner {
  const owner: TelegramLockTransactionOwner = {
    pid: process.pid,
    acquiredAtMs: Date.now(),
    generation: randomUUID(),
  };
  const stagedPath = mkdtempSync(`${path}.staged.`);
  try {
    chmodSync(stagedPath, 0o700);
    writeFileSync(
      join(stagedPath, getLockTransactionOwnerFile(owner.generation)),
      `${JSON.stringify(owner)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    if (existsSync(path)) throw createLockTransactionContentionError(path);
    renameSync(stagedPath, path);
    return owner;
  } finally {
    try {
      removeLockTransactionGuard(stagedPath);
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
  const releasedPath = `${path}.released.${randomUUID()}`;
  for (
    let attempt = 0;
    attempt < TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    try {
      renameSync(path, releasedPath);
      try {
        removeLockTransactionGuard(releasedPath);
      } catch {
        /* released debris cannot retain transaction authority */
      }
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

const TELEGRAM_TRANSACTION_RECLAIM_PATTERN =
  /^owner\.reclaim\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;
const TELEGRAM_ACTIVE_TRANSACTION_RECLAIMS = Symbol.for(
  "@llblab/pi-telegram/active-transaction-reclaims",
);

type TelegramTransactionGlobal = typeof globalThis & {
  [TELEGRAM_ACTIVE_TRANSACTION_RECLAIMS]?: Set<string>;
};

export interface TelegramFileTransactionOptions {
  recoveryRename?: typeof renameSync;
  attempts?: number;
  retryDelayMs?: number;
}

function getActiveTransactionReclaims(): Set<string> {
  const root = globalThis as TelegramTransactionGlobal;
  return (root[TELEGRAM_ACTIVE_TRANSACTION_RECLAIMS] ??= new Set());
}

function reclaimAbandonedDirectoryGuard(
  path: string,
  options: TelegramFileTransactionOptions = {},
): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    // Another recovery candidate may remove the observed guard after lstat.
    return false;
  }
  if (entries.length !== 1) return false;
  const entry = entries[0];
  let observedPid: number;
  let observedReclaimGeneration: string | undefined;
  if (TELEGRAM_TRANSACTION_OWNER_PATTERN.test(entry)) {
    const owner = readLockTransactionOwner(path);
    if (!owner) return false;
    observedPid = owner.pid;
  } else {
    const match = TELEGRAM_TRANSACTION_RECLAIM_PATTERN.exec(entry);
    if (!match) return false;
    observedPid = Number.parseInt(match[1], 10);
    observedReclaimGeneration = match[2];
  }
  const activeReclaims = getActiveTransactionReclaims();
  if (observedPid === process.pid && observedReclaimGeneration !== undefined) {
    if (activeReclaims.has(observedReclaimGeneration)) return false;
  } else if (isProcessAlive(observedPid)) {
    return false;
  }

  const renameRecovery = options.recoveryRename ?? renameSync;
  const sourcePath = join(path, entry);
  const reclaimGeneration = randomUUID();
  const reclaimPath = join(
    path,
    `owner.reclaim.${process.pid}.${reclaimGeneration}.json`,
  );
  try {
    // Claim inside the still-occupied guard before making its stable path free.
    renameRecovery(sourcePath, reclaimPath);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return false;
    throw error;
  }

  const renameWithRetry = (fromPath: string, toPath: string): boolean => {
    for (
      let attempt = 0;
      attempt < TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS;
      attempt += 1
    ) {
      try {
        renameRecovery(fromPath, toPath);
        return true;
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOENT") return false;
        if (
          !isRetryableLockWriteError(error) ||
          attempt === TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS - 1
        ) {
          throw error;
        }
        sleepSync(TELEGRAM_LOCK_WRITE_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    return false;
  };

  activeReclaims.add(reclaimGeneration);
  const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
  try {
    try {
      if (!renameWithRetry(path, stalePath)) return false;
    } catch (renameError) {
      try {
        if (!renameWithRetry(reclaimPath, sourcePath)) throw renameError;
      } catch (rollbackError) {
        throw new AggregateError(
          [renameError, rollbackError],
          `Failed to reclaim or restore Telegram lock transaction guard: ${path}`,
        );
      }
      throw renameError;
    }
  } finally {
    activeReclaims.delete(reclaimGeneration);
  }
  try {
    removeLockTransactionGuard(stalePath);
  } catch {
    /* stale debris cannot retain transaction authority */
  }
  return true;
}

function acquireRecoverableDirectoryGuard(
  path: string,
  options: TelegramFileTransactionOptions = {},
): TelegramLockTransactionOwner | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return createLockTransactionGuard(path);
    } catch (error) {
      if (!isLockTransactionContentionError(error, path)) throw error;
      if (!reclaimAbandonedDirectoryGuard(path, options)) return undefined;
    }
  }
  return undefined;
}

function removeAbandonedLegacyRecoveryGuard(
  path: string,
  options: TelegramFileTransactionOptions = {},
): boolean {
  try {
    if (!lstatSync(path).isFile() || !isAbandonedLockTransaction(path))
      return false;
  } catch {
    return false;
  }
  const migrationGuardPath = `${path}.migration`;
  const migrationOwner = acquireRecoverableDirectoryGuard(
    migrationGuardPath,
    options,
  );
  if (!migrationOwner) return false;
  try {
    try {
      if (!lstatSync(path).isFile() || !isAbandonedLockTransaction(path))
        return false;
    } catch {
      return false;
    }
    const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
    try {
      renameSync(path, stalePath);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return false;
      throw error;
    }
    try {
      removeLockTransactionGuard(stalePath);
    } catch {
      /* stale debris cannot retain transaction authority */
    }
    return true;
  } finally {
    releaseLockTransactionGuard(migrationGuardPath, migrationOwner);
  }
}

function acquireLegacyRecoveryGuard(
  path: string,
  options: TelegramFileTransactionOptions = {},
): TelegramLockTransactionOwner | undefined {
  let owner = acquireRecoverableDirectoryGuard(path, options);
  if (owner) return owner;
  if (!removeAbandonedLegacyRecoveryGuard(path, options)) return undefined;
  owner = acquireRecoverableDirectoryGuard(path, options);
  return owner;
}

function createRecoveredLockTransactionGuard(
  path: string,
): TelegramLockTransactionOwner | undefined {
  try {
    return createLockTransactionGuard(path);
  } catch (error) {
    if (isLockTransactionContentionError(error, path)) return undefined;
    throw error;
  }
}

function recoverAbandonedLockTransaction(
  path: string,
  options: TelegramFileTransactionOptions = {},
): TelegramLockTransactionOwner | undefined {
  if (!isAbandonedLockTransaction(path)) return undefined;
  let isDirectory: boolean;
  try {
    isDirectory = lstatSync(path).isDirectory();
  } catch {
    return undefined;
  }
  if (isDirectory) {
    if (!reclaimAbandonedDirectoryGuard(path, options)) return undefined;
    const recoveredOwner = createRecoveredLockTransactionGuard(path);
    try {
      reclaimAbandonedDirectoryGuard(`${path}.recovery`, options);
      return recoveredOwner;
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

  const recoveryGuardPath = `${path}.recovery`;
  const recoveryOwner = acquireLegacyRecoveryGuard(recoveryGuardPath, options);
  if (!recoveryOwner) return undefined;
  let recoveredOwner: TelegramLockTransactionOwner | undefined;
  try {
    if (!isAbandonedLockTransaction(path)) return undefined;
    const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
    try {
      renameSync(path, stalePath);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      removeLockTransactionGuard(stalePath);
    } catch {
      /* stale debris cannot retain transaction authority */
    }
    recoveredOwner = createRecoveredLockTransactionGuard(path);
    return recoveredOwner;
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

function acquireLockTransaction(
  path: string,
  options: TelegramFileTransactionOptions = {},
): TelegramLockTransactionOwner {
  const attempts = Math.max(
    1,
    options.attempts ?? TELEGRAM_LOCK_TRANSACTION_ATTEMPTS,
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? TELEGRAM_LOCK_TRANSACTION_RETRY_DELAY_MS,
  );
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return createLockTransactionGuard(path);
    } catch (error) {
      if (!isLockTransactionContentionError(error, path)) throw error;
      const recoveredOwner = recoverAbandonedLockTransaction(path, options);
      if (recoveredOwner !== undefined) return recoveredOwner;
      if (attempt === attempts - 1) {
        throw new Error(
          `Timed out acquiring Telegram lock transaction: ${path}`,
        );
      }
      sleepSync(retryDelayMs);
    }
  }
  throw new Error(`Failed to acquire Telegram lock transaction: ${path}`);
}

export function withTelegramFileTransaction<T>(
  transactionPath: string,
  operation: () => T,
  options: TelegramFileTransactionOptions = {},
): T {
  const owner = acquireLockTransaction(transactionPath, options);
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
  const locksPath = options.locksPath ?? getOwnersPath();
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
  onTransportAvailabilityChanged?: () => void;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  ownershipCheckMs?: number;
  ownershipRefreshMs?: number;
}

function snapshotLockContext(ctx: TelegramLockContext): TelegramLockContext {
  return { cwd: ctx.cwd };
}

export function createTelegramLockedPollingRuntime<
  TContext extends TelegramLockContext,
>(
  deps: TelegramLockedPollingRuntimeDeps<TContext>,
): TelegramLockedPollingRuntime<TContext> {
  let ownershipCheckInterval: ReturnType<typeof setInterval> | undefined;
  let ownershipRefreshInterval: ReturnType<typeof setInterval> | undefined;
  let ownershipStop: Promise<void> | undefined;
  let takeoverCandidate: TelegramLockEntry | undefined;
  let sessionAutoStartRun: Promise<void> | undefined;
  let sessionAutoStartGeneration = 0;
  const ownershipCheckMs = deps.ownershipCheckMs ?? 1000;
  const ownershipRefreshMs =
    deps.ownershipRefreshMs ?? TELEGRAM_OWNERSHIP_REFRESH_MS;
  const stopOwnershipWatcher = () => {
    if (ownershipCheckInterval) clearInterval(ownershipCheckInterval);
    if (ownershipRefreshInterval) clearInterval(ownershipRefreshInterval);
    ownershipCheckInterval = undefined;
    ownershipRefreshInterval = undefined;
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
    deps.onTransportAvailabilityChanged?.();
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
    ownershipCheckInterval = setInterval(() => {
      try {
        if (deps.lock.owns(owner)) return;
      } catch (error) {
        deps.recordRuntimeEvent?.("lock", error, { phase: "check" });
      }
      stopAfterOwnershipLoss();
    }, ownershipCheckMs);
    ownershipRefreshInterval = setInterval(() => {
      try {
        if (deps.lock.refresh(owner)) return;
      } catch (error) {
        deps.recordRuntimeEvent?.("lock", error, { phase: "refresh" });
      }
      stopAfterOwnershipLoss();
    }, ownershipRefreshMs);
    ownershipCheckInterval.unref?.();
    ownershipRefreshInterval.unref?.();
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
      deps.onTransportAvailabilityChanged?.();
      throw error;
    }
    if (deps.lock.owns(ctx)) return true;
    stopOwnershipWatcher();
    if (ownershipStop) await ownershipStop;
    await deps.stopPolling();
    deps.onTransportAvailabilityChanged?.();
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
      deps.onTransportAvailabilityChanged?.();
      deps.updateStatus(ctx);
      const staleSuffix = acquired.replacedStale ? " Replaced stale lock." : "";
      return { ok: true, message: `Telegram bridge connected.${staleSuffix}` };
    },
    stop: async () => {
      await suspendPolling();
      const state = deps.lock.release();
      deps.onTransportAvailabilityChanged?.();
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
        deps.onTransportAvailabilityChanged?.();
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
