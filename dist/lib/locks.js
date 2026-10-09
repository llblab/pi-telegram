/**
 * Telegram singleton lock helpers
 * Zones: telegram ownership, filesystem, transport authority
 * Owns filesystem authority, atomic runtime-section publication and Telegram bridge ownership semantics
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isTelegramSessionPollingJournalPath, resolveTelegramOwnersPath, resolveTelegramSessionPollingJournalPath, resolveTelegramUpdateJournalPathForProfile, } from "./paths.js";
import { isProcessAlive } from "./process-identity.js";
import { isWireRecord as runtimeStateRecord } from "./wire.js";
export const TELEGRAM_LOCK_KEY = "default";
export const TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS = 8_000;
export const TELEGRAM_OWNERSHIP_CHECK_MS = 1_000;
export const TELEGRAM_OWNERSHIP_REFRESH_MS = 2_000;
/** Consecutive unverified ownership checks tolerated before standing down; a concurrent shared-state replacement must not stop an owned transport. */
export const TELEGRAM_OWNERSHIP_CHECK_FAILURE_TOLERANCE = 2;
const TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS = 5;
const TELEGRAM_LOCK_WRITE_RETRY_DELAY_MS = 25;
const TELEGRAM_LOCK_TRANSACTION_ATTEMPTS = 80;
const TELEGRAM_LOCK_TRANSACTION_RETRY_DELAY_MS = 25;
const TELEGRAM_LOCK_RUNTIME_GENERATION_KEY = "__piTelegramLockRuntimeGeneration__";
function allocateTelegramLockRuntimeGeneration() {
    const globals = globalThis;
    const previous = globals[TELEGRAM_LOCK_RUNTIME_GENERATION_KEY];
    const previousGeneration = typeof previous === "number" && Number.isSafeInteger(previous)
        ? previous
        : 0;
    const generation = Math.max(Date.now(), previousGeneration + 1);
    globals[TELEGRAM_LOCK_RUNTIME_GENERATION_KEY] = generation;
    return generation;
}
function getOwnersPath() {
    return resolveTelegramOwnersPath();
}
/**
 * Resolve the extension-local owner slot for the active Telegram profile.
 * Default profile → default
 * Named profile → the validated profile name
 */
export function resolveTelegramLockKey(activeProfile) {
    return activeProfile || TELEGRAM_LOCK_KEY;
}
export function createTelegramLockKeyResolver(activeProfile) {
    return function getTelegramLockKey() {
        return resolveTelegramLockKey(activeProfile.getActiveProfileName());
    };
}
/**
 * Captures exact context, session generation and owned leader epoch before awaits.
 * Session replacement, release or re-election revokes the grant; a successor never renews it.
 */
export function createTelegramOwnedStateAuthorityCapture(lock, session) {
    return () => {
        const ctx = session.get(), generation = session.getGeneration();
        if (ctx === undefined || !session.isCurrent(ctx, generation))
            return undefined;
        const epoch = lock.getOwnedLeaderEpoch();
        if (epoch === undefined)
            return undefined;
        const current = () => session.isCurrent(ctx, generation) &&
            lock.owns(ctx) &&
            lock.getOwnedLeaderEpoch() === epoch;
        return current() ? current : undefined;
    };
}
/**
 * Leader polling journal: the path owners.json names, else the session that would host it on acquisition.
 * Without a session identity, the flat root `inbox` remains the compatibility fallback.
 */
export function createTelegramLeaderJournalPathResolver(deps) {
    // An existing flat root journal keeps its custody; new installations never create one.
    const createOwn = (profileName = deps.getProfileName()) => {
        const root = resolveTelegramUpdateJournalPathForProfile(profileName);
        if (existsSync(root))
            return root;
        const sessionId = deps.getSessionId();
        return sessionId === undefined
            ? undefined
            : resolveTelegramSessionPollingJournalPath(sessionId, undefined, profileName);
    };
    return {
        createJournalPath: () => createOwn(),
        resolve(profileName) {
            const named = deps.getNamedJournalPath();
            if (named &&
                (isTelegramSessionPollingJournalPath(named) ||
                    named === resolveTelegramUpdateJournalPathForProfile(profileName)))
                return named;
            return (createOwn(profileName) ??
                resolveTelegramUpdateJournalPathForProfile(profileName));
        },
    };
}
/** A released key keeps only `{ journalPath }`: no owner, but the successor's polling custody. */
export function readTelegramLockJournalPath(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const path = value.journalPath;
    return typeof path === "string" && path ? path : undefined;
}
export function readLocks(path = getOwnersPath()) {
    if (!existsSync(path))
        return {};
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value)
            ? value
            : {};
    }
    catch {
        return {};
    }
}
function readLocksForTransaction(path) {
    let source;
    try {
        source = readFileSync(path, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return {};
        throw error;
    }
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid Telegram owner store: ${path}`);
    }
    return value;
}
function isRetryableLockWriteError(error) {
    const code = error?.code;
    return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}
function sleepSync(ms) {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}
/** Typed private-file refusal; owners map the failure into their own error vocabulary. */
export class TelegramPrivateFileError extends Error {
    failure;
    constructor(failure, message) {
        super(message);
        this.failure = failure;
        this.name = "TelegramPrivateFileError";
    }
}
/**
 * Read flags for private runtime files. Where the platform offers them, no-follow and non-blocking opens refuse a
 * swapped link or FIFO at open time. Windows has neither flag and no FIFOs in the file namespace; there the
 * lstat-before/fstat-after identity binding every strict reader performs is the guard, so a link swapped in after
 * inspection opens a different file and is refused as changed.
 */
export const TELEGRAM_STRICT_READ_FLAGS = constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);
/** POSIX owner and permission bits; Windows has no uid, so its ACL-protected agent directory carries privacy. */
export function isTelegramOwnerPrivate(stat) {
    const uid = process.getuid?.();
    return (uid === undefined ||
        (stat.uid === BigInt(uid) && (stat.mode & 63n) === 0n));
}
/**
 * Read one owner-private, single-link, bounded regular file without following links. Absence returns undefined;
 * an inode or metadata change between inspection and open refuses as `changed`.
 */
export function readTelegramPrivateFile(path, maxBytes) {
    let before;
    try {
        before = lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return undefined;
        throw error;
    }
    if (!before.isFile() ||
        before.isSymbolicLink() ||
        !isTelegramOwnerPrivate(before) ||
        before.nlink !== 1n ||
        before.size > BigInt(maxBytes)) {
        throw new TelegramPrivateFileError(before.size > BigInt(maxBytes) ? "capacity" : "unsafe", "Telegram private file is not a bounded no-follow regular file.");
    }
    const fd = openSync(path, TELEGRAM_STRICT_READ_FLAGS);
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.uid !== before.uid ||
            opened.nlink !== 1n ||
            !isTelegramOwnerPrivate(opened) ||
            opened.size !== before.size ||
            opened.mtimeNs !== before.mtimeNs) {
            throw new TelegramPrivateFileError("changed", "Telegram private file changed during inspection.");
        }
        return readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
}
/** Atomically publish owner-private contents through a unique staging file; the rename consumes staging. */
export function publishTelegramPrivateFile(path, temporaryBasePath, contents, label, onBoundary) {
    const temporaryPath = `${temporaryBasePath}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(temporaryPath), { recursive: true, mode: 0o700 });
    try {
        writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
        chmodSync(temporaryPath, 0o600);
        onBoundary?.("after-write-before-rename");
        if (!renameTelegramPathWithRetry(temporaryPath, path))
            throw new Error(`${label} staging file disappeared before publication.`);
        chmodSync(path, 0o600);
        onBoundary?.("after-rename");
    }
    finally {
        try {
            unlinkSync(temporaryPath);
        }
        catch {
            /* Atomic rename consumes the temporary path. */
        }
    }
}
/** Rename one Telegram runtime artifact with bounded Windows sharing retries. */
export function renameTelegramPathWithRetry(sourcePath, destinationPath, options = {}) {
    const rename = options.rename ?? renameSync;
    const attempts = Math.max(1, options.attempts ?? TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? TELEGRAM_LOCK_WRITE_RETRY_DELAY_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            rename(sourcePath, destinationPath);
            return true;
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return false;
            if (!isRetryableLockWriteError(error) || attempt === attempts - 1) {
                throw error;
            }
            sleepSync(retryDelayMs * (attempt + 1));
        }
    }
    return false;
}
const TELEGRAM_TRANSACTION_OWNER_PATTERN = /^owner\.([A-Za-z0-9-]+)\.json$/u;
function getLockTransactionOwnerFile(generation) {
    return `owner.${generation}.json`;
}
function getLockTransactionOwnerPath(path) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
        const entries = readdirSync(path);
        if (entries.length === 1 &&
            (TELEGRAM_TRANSACTION_OWNER_PATTERN.test(entries[0]) ||
                TELEGRAM_TRANSACTION_RECLAIM_PATTERN.test(entries[0]))) {
            return join(path, entries[0]);
        }
        throw new Error(`Unverifiable Telegram lock transaction guard: ${path}`);
    }
    if (stat.isFile())
        return path;
    throw new Error(`Unsupported Telegram lock transaction guard: ${path}`);
}
function readLockTransactionOwner(path) {
    try {
        const value = JSON.parse(readFileSync(getLockTransactionOwnerPath(path), "utf8"));
        if (typeof value.pid !== "number" ||
            typeof value.acquiredAtMs !== "number" ||
            typeof value.generation !== "string") {
            return undefined;
        }
        const ownerMatch = TELEGRAM_TRANSACTION_OWNER_PATTERN.exec(basename(getLockTransactionOwnerPath(path)));
        if (ownerMatch && ownerMatch[1] !== value.generation)
            return undefined;
        return {
            pid: value.pid,
            acquiredAtMs: value.acquiredAtMs,
            generation: value.generation,
        };
    }
    catch {
        return undefined;
    }
}
function createLockTransactionContentionError(path) {
    return Object.assign(new Error(`Telegram lock transaction guard already exists: ${path}`), { code: "EEXIST" });
}
function isLockTransactionContentionError(error) {
    const code = error?.code;
    return (code === "EEXIST" ||
        code === "ENOTEMPTY" ||
        code === "ENOTDIR" ||
        code === "EISDIR" ||
        isRetryableLockWriteError(error));
}
function removeLockTransactionGuard(path) {
    rmSync(path, { recursive: true, force: true });
}
function createLockTransactionGuard(path, options = {}) {
    const owner = {
        pid: process.pid,
        acquiredAtMs: Date.now(),
        generation: randomUUID(),
    };
    const stagedPath = mkdtempSync(`${path}.staged.`);
    try {
        chmodSync(stagedPath, 0o700);
        writeFileSync(join(stagedPath, getLockTransactionOwnerFile(owner.generation)), `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        if (existsSync(path))
            throw createLockTransactionContentionError(path);
        (options.publishRename ?? renameSync)(stagedPath, path);
        return owner;
    }
    finally {
        try {
            removeLockTransactionGuard(stagedPath);
        }
        catch {
            /* best effort */
        }
    }
}
function releaseLockTransactionGuard(path, owner) {
    const current = readLockTransactionOwner(path);
    if (!current) {
        if (!existsSync(path))
            return;
        throw new Error(`Cannot verify Telegram lock transaction guard: ${path}`);
    }
    if (current.pid !== owner.pid ||
        current.generation !== owner.generation ||
        current.acquiredAtMs !== owner.acquiredAtMs) {
        throw new Error(`Telegram lock transaction guard changed ownership: ${path}`);
    }
    const releasedPath = `${path}.released.${randomUUID()}`;
    if (!renameTelegramPathWithRetry(path, releasedPath))
        return;
    try {
        removeLockTransactionGuard(releasedPath);
    }
    catch {
        /* released debris cannot retain transaction authority */
    }
}
function isAbandonedLockTransaction(path) {
    const owner = readLockTransactionOwner(path);
    return owner ? !isProcessAlive(owner.pid) : false;
}
const TELEGRAM_TRANSACTION_RECLAIM_PATTERN = /^owner\.reclaim\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;
const TELEGRAM_ACTIVE_TRANSACTION_RECLAIMS = Symbol.for("@llblab/pi-telegram/active-transaction-reclaims");
function getActiveTransactionReclaims() {
    const root = globalThis;
    return (root[TELEGRAM_ACTIVE_TRANSACTION_RECLAIMS] ??= new Set());
}
function reclaimAbandonedDirectoryGuard(path, options = {}) {
    try {
        if (!lstatSync(path).isDirectory())
            return false;
    }
    catch {
        return false;
    }
    let entries;
    try {
        entries = readdirSync(path);
    }
    catch {
        // Another recovery candidate may remove the observed guard after lstat.
        return false;
    }
    if (entries.length !== 1)
        return false;
    const entry = entries[0];
    let observedPid;
    let observedReclaimGeneration;
    if (TELEGRAM_TRANSACTION_OWNER_PATTERN.test(entry)) {
        const owner = readLockTransactionOwner(path);
        if (!owner)
            return false;
        observedPid = owner.pid;
    }
    else {
        const match = TELEGRAM_TRANSACTION_RECLAIM_PATTERN.exec(entry);
        if (!match)
            return false;
        observedPid = Number.parseInt(match[1], 10);
        observedReclaimGeneration = match[2];
    }
    const activeReclaims = getActiveTransactionReclaims();
    if (observedPid === process.pid && observedReclaimGeneration !== undefined) {
        if (activeReclaims.has(observedReclaimGeneration))
            return false;
    }
    else if (isProcessAlive(observedPid)) {
        return false;
    }
    const renameRecovery = options.recoveryRename ?? renameSync;
    const sourcePath = join(path, entry);
    const reclaimGeneration = randomUUID();
    const reclaimPath = join(path, `owner.reclaim.${process.pid}.${reclaimGeneration}.json`);
    try {
        // Claim inside the still-occupied guard before making its stable path free.
        renameRecovery(sourcePath, reclaimPath);
    }
    catch (error) {
        const code = error?.code;
        if (code === "ENOENT")
            return false;
        // macOS may report EINVAL instead of ENOENT when another process wins
        // the same source rename. Only classify it as contention once the
        // observed source is actually gone; preserve unrelated EINVAL failures.
        if (code === "EINVAL" && !existsSync(sourcePath))
            return false;
        throw error;
    }
    const renameWithRetry = (fromPath, toPath) => renameTelegramPathWithRetry(fromPath, toPath, { rename: renameRecovery });
    activeReclaims.add(reclaimGeneration);
    const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
    try {
        try {
            if (!renameWithRetry(path, stalePath))
                return false;
        }
        catch (renameError) {
            try {
                if (!renameWithRetry(reclaimPath, sourcePath))
                    throw renameError;
            }
            catch (rollbackError) {
                throw new AggregateError([renameError, rollbackError], `Failed to reclaim or restore Telegram lock transaction guard: ${path}`);
            }
            throw renameError;
        }
    }
    finally {
        activeReclaims.delete(reclaimGeneration);
    }
    try {
        removeLockTransactionGuard(stalePath);
    }
    catch {
        /* stale debris cannot retain transaction authority */
    }
    return true;
}
function acquireRecoverableDirectoryGuard(path, options = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return createLockTransactionGuard(path, options);
        }
        catch (error) {
            if (!isLockTransactionContentionError(error))
                throw error;
            if (!reclaimAbandonedDirectoryGuard(path, options))
                return undefined;
        }
    }
    return undefined;
}
function removeAbandonedLegacyRecoveryGuard(path, options = {}) {
    try {
        if (!lstatSync(path).isFile() || !isAbandonedLockTransaction(path))
            return false;
    }
    catch {
        return false;
    }
    const migrationGuardPath = `${path}.migration`;
    const migrationOwner = acquireRecoverableDirectoryGuard(migrationGuardPath, options);
    if (!migrationOwner)
        return false;
    try {
        try {
            if (!lstatSync(path).isFile() || !isAbandonedLockTransaction(path))
                return false;
        }
        catch {
            return false;
        }
        const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
        try {
            renameSync(path, stalePath);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return false;
            throw error;
        }
        try {
            removeLockTransactionGuard(stalePath);
        }
        catch {
            /* stale debris cannot retain transaction authority */
        }
        return true;
    }
    finally {
        releaseLockTransactionGuard(migrationGuardPath, migrationOwner);
    }
}
function acquireLegacyRecoveryGuard(path, options = {}) {
    let owner = acquireRecoverableDirectoryGuard(path, options);
    if (owner)
        return owner;
    if (!removeAbandonedLegacyRecoveryGuard(path, options))
        return undefined;
    owner = acquireRecoverableDirectoryGuard(path, options);
    return owner;
}
function createRecoveredLockTransactionGuard(path, options = {}) {
    try {
        return createLockTransactionGuard(path, options);
    }
    catch (error) {
        if (isLockTransactionContentionError(error))
            return undefined;
        throw error;
    }
}
function recoverAbandonedLockTransaction(path, options = {}) {
    if (!isAbandonedLockTransaction(path))
        return undefined;
    let isDirectory;
    try {
        isDirectory = lstatSync(path).isDirectory();
    }
    catch {
        return undefined;
    }
    if (isDirectory) {
        if (!reclaimAbandonedDirectoryGuard(path, options))
            return undefined;
        const recoveredOwner = createRecoveredLockTransactionGuard(path, options);
        try {
            reclaimAbandonedDirectoryGuard(`${path}.recovery`, options);
            return recoveredOwner;
        }
        catch (error) {
            if (recoveredOwner) {
                try {
                    releaseLockTransactionGuard(path, recoveredOwner);
                }
                catch {
                    /* preserve the recovery cleanup failure */
                }
            }
            throw error;
        }
    }
    const recoveryGuardPath = `${path}.recovery`;
    const recoveryOwner = acquireLegacyRecoveryGuard(recoveryGuardPath, options);
    if (!recoveryOwner)
        return undefined;
    let recoveredOwner;
    try {
        if (!isAbandonedLockTransaction(path))
            return undefined;
        const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
        try {
            renameSync(path, stalePath);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return undefined;
            throw error;
        }
        try {
            removeLockTransactionGuard(stalePath);
        }
        catch {
            /* stale debris cannot retain transaction authority */
        }
        recoveredOwner = createRecoveredLockTransactionGuard(path, options);
        return recoveredOwner;
    }
    finally {
        try {
            releaseLockTransactionGuard(recoveryGuardPath, recoveryOwner);
        }
        catch (error) {
            if (recoveredOwner) {
                try {
                    releaseLockTransactionGuard(path, recoveredOwner);
                }
                catch {
                    /* preserve the recovery cleanup failure */
                }
            }
            throw error;
        }
    }
}
function acquireLockTransaction(path, options = {}) {
    const attempts = Math.max(1, options.attempts ?? TELEGRAM_LOCK_TRANSACTION_ATTEMPTS);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? TELEGRAM_LOCK_TRANSACTION_RETRY_DELAY_MS);
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return createLockTransactionGuard(path, options);
        }
        catch (error) {
            if (!isLockTransactionContentionError(error))
                throw error;
            const recoveredOwner = recoverAbandonedLockTransaction(path, options);
            if (recoveredOwner !== undefined)
                return recoveredOwner;
            if (attempt === attempts - 1) {
                throw new Error(`Timed out acquiring Telegram lock transaction: ${path}`);
            }
            sleepSync(retryDelayMs);
        }
    }
    throw new Error(`Failed to acquire Telegram lock transaction: ${path}`);
}
export function withTelegramFileTransaction(transactionPath, operation, options = {}) {
    const owner = acquireLockTransaction(transactionPath, options);
    try {
        return operation();
    }
    finally {
        releaseLockTransactionGuard(transactionPath, owner);
    }
}
export class TelegramRuntimeStateError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = "TelegramRuntimeStateError";
        this.code = code;
    }
}
const TELEGRAM_RUNTIME_STATE_SECTIONS = ["transport", "workspace", "admission", "runtime"];
const TELEGRAM_ACTIVE_STATE_TRANSACTIONS = Symbol.for("@llblab/pi-telegram/active-state-transactions");
function requireRuntimeStatePath(path) {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
        throw new TelegramRuntimeStateError("invalid", "Telegram runtime state path must be canonical and absolute.");
}
function requireRuntimeStateProfile(profile) {
    if (typeof profile !== "string" ||
        !profile.length ||
        profile.length > 512 ||
        /[\x00-\x1f]/u.test(profile))
        throw new TelegramRuntimeStateError("invalid", "Telegram runtime state profile is invalid.");
}
/** Private single-link regular file read with identity continuity; initial absence only is positive. */
function readTelegramRuntimeSource(path) {
    requireRuntimeStatePath(path);
    let source;
    let observed = false;
    try {
        const stat = lstatSync(path);
        observed = true;
        if (!stat.isFile() ||
            stat.nlink !== 1 ||
            (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
            throw new TelegramRuntimeStateError("invalid", "Telegram runtime state must be a private regular file.");
        const fd = openSync(path, "r");
        try {
            const opened = fstatSync(fd);
            if (opened.dev !== stat.dev ||
                opened.ino !== stat.ino ||
                opened.nlink !== 1 ||
                !opened.isFile() ||
                (process.platform !== "win32" && (opened.mode & 0o077) !== 0))
                throw new TelegramRuntimeStateError("invalid", "Telegram runtime state identity changed before reading.");
            source = readFileSync(fd).toString("utf8");
        }
        finally {
            closeSync(fd);
        }
        const after = lstatSync(path);
        if (after.dev !== stat.dev ||
            after.ino !== stat.ino ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs)
            throw new TelegramRuntimeStateError("invalid", "Telegram runtime state changed during observation.");
    }
    catch (error) {
        if (!observed && error.code === "ENOENT")
            return undefined;
        throw error;
    }
    return source;
}
/** Strict, observational envelope read; section owners validate their own payloads. Legacy state is never adopted here. */
export function readTelegramRuntimeState(path) {
    const observed = readTelegramRuntimeSource(path);
    if (observed === undefined)
        return { version: 2, profiles: {} };
    let value;
    try {
        value = JSON.parse(observed);
    }
    catch (error) {
        throw new TelegramRuntimeStateError("invalid", "Telegram runtime state is unreadable.", { cause: error });
    }
    if (!runtimeStateRecord(value) ||
        value.version !== 2 ||
        !runtimeStateRecord(value.profiles) ||
        Object.keys(value).some((key) => key !== "version" && key !== "profiles"))
        throw new TelegramRuntimeStateError("invalid", "Telegram runtime state envelope is unsupported or malformed.");
    for (const [profile, sections] of Object.entries(value.profiles)) {
        requireRuntimeStateProfile(profile);
        if (!runtimeStateRecord(sections) ||
            Object.keys(sections).some((key) => !TELEGRAM_RUNTIME_STATE_SECTIONS.includes(key)))
            throw new TelegramRuntimeStateError("invalid", "Telegram runtime state sections are malformed.");
    }
    return value;
}
/**
 * Operator-approved optimistic recovery before leader acquisition: when the shared envelope, any transport section or a
 * caller-validated section is damaged, publish a fresh empty envelope instead of refusing. All profiles lose runtime
 * continuity. Filesystem access errors are not damage and still throw. Returns whether a reset was published.
 */
export function resetDamagedTelegramRuntimeState(path, validateProfile) {
    requireRuntimeStatePath(path);
    const runtimeDir = join(dirname(path), "runtime");
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    return withTelegramFileTransaction(join(runtimeDir, `${basename(path)}.transaction`), () => {
        let damaged = false;
        try {
            for (const [profile, sections] of Object.entries(readTelegramRuntimeState(path).profiles)) {
                assertTelegramStateTransport(sections.transport);
                try {
                    validateProfile?.(profile, sections);
                }
                catch {
                    damaged = true;
                }
            }
        }
        catch (error) {
            if (!(error instanceof TelegramRuntimeStateError))
                throw error;
            damaged = true;
        }
        if (!damaged)
            return false;
        const tempPath = join(runtimeDir, `${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
        try {
            writeFileSync(tempPath, `${JSON.stringify({ version: 2, profiles: {} }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
            if (!renameTelegramPathWithRetry(tempPath, path))
                throw new Error("Telegram runtime state reset publication disappeared.");
        }
        finally {
            try {
                unlinkSync(tempPath);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        return true;
    });
}
/**
 * One physical read/check/write transaction for one named section. The caller supplies domain policy; copies expose
 * current sibling facts without granting writes to them. No await, nested transaction, repair or legacy import.
 */
export function mutateTelegramRuntimeStateSection(path, profile, section, mutate, options) {
    requireRuntimeStatePath(path);
    requireRuntimeStateProfile(profile);
    if (!TELEGRAM_RUNTIME_STATE_SECTIONS.includes(section))
        throw new TelegramRuntimeStateError("invalid", "Telegram runtime state section is invalid.");
    const active = (globalThis[TELEGRAM_ACTIVE_STATE_TRANSACTIONS] ??= new Set());
    if (active.has(path))
        throw new TelegramRuntimeStateError("invalid", "Nested Telegram runtime state transaction is not allowed.");
    const assertCurrent = () => {
        if (!options.isCurrent())
            throw new TelegramRuntimeStateError("authority-changed", "Telegram runtime state publication authority changed.");
    };
    assertCurrent();
    active.add(path);
    try {
        const runtimeDir = join(dirname(path), "runtime");
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        return withTelegramFileTransaction(join(runtimeDir, `${basename(path)}.transaction`), () => {
            assertCurrent();
            const file = readTelegramRuntimeState(path);
            const previous = Object.hasOwn(file.profiles, profile)
                ? file.profiles[profile]
                : {};
            const outcome = mutate(structuredClone(previous[section]), structuredClone(previous));
            if (!runtimeStateRecord(outcome) ||
                !Object.hasOwn(outcome, "value") ||
                !Object.hasOwn(outcome, "result") ||
                "then" in outcome)
                throw new TelegramRuntimeStateError("invalid", "Telegram runtime state mutations must return a synchronous value and result.");
            // Normalize intentional optional properties to their wire representation before comparison/publication.
            const next = outcome.value === undefined
                ? undefined
                : JSON.parse(JSON.stringify(outcome.value));
            assertCurrent();
            if (isDeepStrictEqual(previous[section], next))
                return outcome.result;
            const updated = { ...previous };
            if (next === undefined)
                delete updated[section];
            else
                updated[section] = next;
            if (Object.keys(updated).length)
                Object.defineProperty(file.profiles, profile, {
                    value: updated,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            else
                delete file.profiles[profile];
            const tempPath = join(runtimeDir, `${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
            try {
                options.onPublicationBoundary?.("before-write");
                assertCurrent();
                writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
                    encoding: "utf8",
                    flag: "wx",
                    mode: 0o600,
                });
                options.onPublicationBoundary?.("after-write-before-rename");
                assertCurrent();
                try {
                    if (!renameTelegramPathWithRetry(tempPath, path, {
                        rename(from, to) {
                            assertCurrent();
                            (options.publishRename ?? renameSync)(from, to);
                        },
                    }))
                        throw new Error("Telegram runtime state temporary publication disappeared.");
                    options.onPublicationBoundary?.("after-rename");
                    assertCurrent();
                }
                catch (error) {
                    throw new TelegramRuntimeStateError("publication-unknown", "Telegram runtime state publication outcome is unknown.", { cause: error });
                }
                return outcome.result;
            }
            finally {
                try {
                    unlinkSync(tempPath);
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                }
            }
        });
    }
    finally {
        active.delete(path);
    }
}
function withLockTransaction(locksPath, mutate) {
    return withTelegramFileTransaction(`${locksPath}.transaction`, () => {
        const locks = readLocksForTransaction(locksPath);
        const outcome = mutate(locks);
        if (outcome.changed)
            writeLocks(locksPath, locks);
        return outcome.result;
    });
}
export function writeLocks(path, locks) {
    mkdirSync(dirname(path), { recursive: true });
    const payload = `${JSON.stringify(locks, null, 2)}\n`;
    let lastError;
    for (let attempt = 0; attempt < TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS; attempt += 1) {
        const tempPath = `${path}.${process.pid}.${Date.now()}.${attempt}.tmp`;
        try {
            writeFileSync(tempPath, payload, {
                encoding: "utf8",
                mode: 0o600,
            });
            renameSync(tempPath, path);
            return;
        }
        catch (error) {
            lastError = error;
            try {
                unlinkSync(tempPath);
            }
            catch {
                /* best effort */
            }
            if (!isRetryableLockWriteError(error) ||
                attempt === TELEGRAM_LOCK_WRITE_RETRY_ATTEMPTS - 1) {
                throw error;
            }
            sleepSync(TELEGRAM_LOCK_WRITE_RETRY_DELAY_MS * (attempt + 1));
        }
    }
    throw lastError;
}
export function parseTelegramLockEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    if (typeof record.pid !== "number")
        return undefined;
    return {
        pid: record.pid,
        cwd: typeof record.cwd === "string" ? record.cwd : undefined,
        instanceId: typeof record.instanceId === "string" ? record.instanceId : undefined,
        heartbeatMs: typeof record.heartbeatMs === "number" ? record.heartbeatMs : undefined,
        leaderEpoch: typeof record.leaderEpoch === "number" ||
            typeof record.leaderEpoch === "string"
            ? record.leaderEpoch
            : undefined,
        runtimeGeneration: typeof record.runtimeGeneration === "number"
            ? record.runtimeGeneration
            : undefined,
        busSocketPath: typeof record.busSocketPath === "string"
            ? record.busSocketPath
            : undefined,
        busSecret: typeof record.busSecret === "string" ? record.busSecret : undefined,
        ...(readTelegramLockJournalPath(record)
            ? { journalPath: readTelegramLockJournalPath(record) }
            : {}),
    };
}
function formatTelegramLockEntry(lock) {
    return lock.cwd ? `pid ${lock.pid}, cwd ${lock.cwd}` : `pid ${lock.pid}`;
}
function formatTelegramFollowerRegistrationFailure(message) {
    if (/\b(?:ENOENT|ECONNREFUSED|ETIMEDOUT)\b/u.test(message)) {
        return (`live owner / unreachable bus endpoint after bounded retries (${message}); ` +
            "wait briefly for owner recovery, then retry /telegram-connect. " +
            "Do not force takeover while the owner remains live");
    }
    return message;
}
function getLockState(lock, pid, isAlive, options = {}) {
    if (!lock)
        return { kind: "inactive" };
    if (lock.pid === pid)
        return { kind: "active-here", lock };
    if (typeof lock.heartbeatMs === "number" &&
        typeof options.nowMs === "number" &&
        typeof options.staleHeartbeatMs === "number" &&
        options.nowMs - lock.heartbeatMs > options.staleHeartbeatMs) {
        return { kind: "stale", lock };
    }
    if (isAlive(lock.pid))
        return { kind: "active-elsewhere", lock };
    return { kind: "stale", lock };
}
function ownsLockContext(lock, pid, ctx) {
    if (!lock || lock.pid !== pid)
        return false;
    return !lock.cwd || !ctx || lock.cwd === ctx.cwd;
}
function hasSameLockOwner(current, expected) {
    if (!current || !expected)
        return false;
    return (current.pid === expected.pid &&
        current.cwd === expected.cwd &&
        current.instanceId === expected.instanceId &&
        current.leaderEpoch === expected.leaderEpoch &&
        current.runtimeGeneration === expected.runtimeGeneration);
}
/** Exact owner identity (pid, cwd, instance, leader epoch, runtime generation); absent entries never match. */
export function isSameTelegramLockOwner(current, expected) {
    return hasSameLockOwner(current, expected);
}
function canSupersedeSameProcessOwner(current, pid, ctx, instanceId, runtimeGeneration) {
    if (current.pid !== pid ||
        (current.cwd !== undefined && current.cwd !== ctx.cwd) ||
        !instanceId) {
        return false;
    }
    return (current.runtimeGeneration === undefined ||
        runtimeGeneration > current.runtimeGeneration);
}
function createLockEntry(pid, ctx, options) {
    const lock = { pid, cwd: ctx.cwd };
    if (options.journalPath)
        lock.journalPath = options.journalPath;
    if (options.instanceId) {
        lock.instanceId = options.instanceId;
        lock.leaderEpoch = options.mintLeaderEpoch?.() ?? randomUUID();
        lock.runtimeGeneration = options.runtimeGeneration;
    }
    if (options.busSocketPath)
        lock.busSocketPath = options.busSocketPath;
    if (options.busSecret)
        lock.busSecret = options.busSecret;
    return lock;
}
function formatLockState(state) {
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
function assertTelegramStateTransport(value) {
    if (value === undefined)
        return;
    if (!runtimeStateRecord(value))
        throw new TelegramRuntimeStateError("invalid", "Telegram state transport is malformed.");
    const keys = [
        "pid",
        "cwd",
        "instanceId",
        "heartbeatMs",
        "leaderEpoch",
        "runtimeGeneration",
        "busSocketPath",
        "busSecret",
        "journalPath",
    ];
    if (Object.keys(value).some((key) => !keys.includes(key)) ||
        (value.pid === undefined
            ? Object.keys(value).length !== 1 || !readTelegramLockJournalPath(value)
            : !Number.isSafeInteger(value.pid) || value.pid <= 0) ||
        ["cwd", "instanceId", "busSocketPath", "busSecret", "journalPath"].some((key) => value[key] !== undefined && typeof value[key] !== "string") ||
        ["heartbeatMs", "runtimeGeneration"].some((key) => value[key] !== undefined &&
            (!Number.isSafeInteger(value[key]) || value[key] < 0)) ||
        (value.journalPath !== undefined && !readTelegramLockJournalPath(value)) ||
        (value.leaderEpoch !== undefined &&
            (typeof value.leaderEpoch === "string"
                ? value.leaderEpoch.length === 0
                : !Number.isSafeInteger(value.leaderEpoch))))
        throw new TelegramRuntimeStateError("invalid", "Telegram state transport is malformed.");
}
export function createTelegramLockRuntime(options = {}) {
    const key = options.key ?? TELEGRAM_LOCK_KEY;
    if (options.statePath && options.locksPath)
        throw new TelegramRuntimeStateError("invalid", "Telegram transport must select one storage identity.");
    const statePath = options.statePath;
    const locksPath = options.locksPath ?? getOwnersPath();
    const pid = options.pid ?? process.pid;
    const isAlive = options.isProcessAlive ?? isProcessAlive;
    const getNowMs = options.getNowMs ?? Date.now;
    const runtimeGeneration = options.runtimeGeneration ?? allocateTelegramLockRuntimeGeneration();
    let ownedLockKey;
    let ownedLock;
    let deliveryRevoked = false;
    const stateOptions = () => ({
        nowMs: getNowMs(),
        staleHeartbeatMs: options.staleHeartbeatMs,
    });
    const resolveEffectiveKey = () => {
        if (typeof key === "function")
            return key() || TELEGRAM_LOCK_KEY;
        return key;
    };
    const readOwners = () => {
        if (!statePath)
            return readLocks(locksPath);
        // Read-only ownership queries fail closed (no owner); acquisition/publication still refuse malformed state.
        // A strict read racing a concurrent atomic replace fails transiently, so retry before failing closed.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const transports = Object.fromEntries(Object.entries(readTelegramRuntimeState(statePath).profiles)
                    .filter(([, value]) => Object.hasOwn(value, "transport"))
                    .map(([profile, value]) => [profile, value.transport]));
                assertTelegramStateTransport(transports[resolveEffectiveKey()]);
                return transports;
            }
            catch {
                // Retry; a persistent failure falls through to no owner.
            }
        }
        return {};
    };
    const transactOwners = (mutate) => {
        if (!statePath)
            return withLockTransaction(locksPath, mutate);
        const profile = resolveEffectiveKey();
        return mutateTelegramRuntimeStateSection(statePath, profile, "transport", (current) => {
            assertTelegramStateTransport(current);
            const locks = { [profile]: current };
            const outcome = mutate(locks);
            const value = outcome.changed ? locks[profile] : current;
            assertTelegramStateTransport(value);
            return { value, result: outcome.result };
        }, {
            ...options.statePublication,
            isCurrent: () => resolveEffectiveKey() === profile,
        });
    };
    const readLock = () => {
        const effectiveKey = resolveEffectiveKey();
        return parseTelegramLockEntry(readOwners()[effectiveKey]);
    };
    // A live older-release leader polls the same bot from its own directory. Only identity is exposed: its bus
    // endpoint, secret and epoch belong to another protocol and must never become a follower target.
    const readLegacyOwner = (effectiveKey) => {
        if (!options.legacyLocksPath ||
            options.legacyLocksPath === (statePath ?? locksPath))
            return undefined;
        try {
            const records = statePath
                ? readLocksForTransaction(options.legacyLocksPath)
                : readLocks(options.legacyLocksPath);
            if (statePath)
                for (const value of Object.values(records))
                    assertTelegramStateTransport(value);
            const raw = records[effectiveKey];
            const legacy = parseTelegramLockEntry(raw);
            if (!legacy ||
                getLockState(legacy, -1, isAlive, stateOptions()).kind !==
                    "active-elsewhere")
                return undefined;
            return {
                pid: legacy.pid,
                ...(legacy.cwd ? { cwd: legacy.cwd } : {}),
                ...(legacy.instanceId ? { instanceId: legacy.instanceId } : {}),
                ...(legacy.heartbeatMs !== undefined
                    ? { heartbeatMs: legacy.heartbeatMs }
                    : {}),
            };
        }
        catch (error) {
            if (statePath)
                throw error;
            return undefined;
        }
    };
    const adoptCompatibleOwnedLock = (effectiveKey, lock, ctx) => {
        if (ownedLock) {
            return ownedLockKey === effectiveKey ? ownedLock : undefined;
        }
        if (!ownsLockContext(lock, pid, ctx))
            return undefined;
        if ((lock?.instanceId !== undefined &&
            lock.instanceId !== options.instanceId) ||
            (lock?.runtimeGeneration !== undefined &&
                lock.runtimeGeneration !== runtimeGeneration)) {
            return undefined;
        }
        ownedLockKey = effectiveKey;
        ownedLock = lock;
        return ownedLock;
    };
    return {
        acquire: (ctx, acquireOptions = {}) => transactOwners((locks) => {
            const effectiveKey = resolveEffectiveKey();
            const legacy = readLegacyOwner(effectiveKey);
            if (legacy)
                return {
                    result: { ok: false, lock: legacy },
                    changed: false,
                };
            const current = parseTelegramLockEntry(locks[effectiveKey]);
            const observedState = getLockState(current, pid, isAlive, stateOptions());
            const state = observedState.kind === "active-elsewhere" &&
                hasSameLockOwner(current, acquireOptions.unresponsiveOwner)
                ? { kind: "stale", lock: observedState.lock }
                : observedState;
            const expectedOwned = adoptCompatibleOwnedLock(effectiveKey, current, ctx);
            if (state.kind === "active-here" &&
                hasSameLockOwner(current, expectedOwned) &&
                !deliveryRevoked) {
                return {
                    result: {
                        ok: true,
                        lock: current,
                        replacedStale: false,
                    },
                    changed: false,
                };
            }
            if (acquireOptions.election && current) {
                if (state.kind !== "stale" ||
                    !hasSameLockOwner(current, acquireOptions.expectedOwner)) {
                    return {
                        result: { ok: false, lock: current },
                        changed: false,
                    };
                }
            }
            const expectedReplacementMatches = hasSameLockOwner(state.kind === "active-here" || state.kind === "active-elsewhere"
                ? state.lock
                : undefined, acquireOptions.expectedOwner);
            const canReplaceCurrent = state.kind === "active-elsewhere" ||
                (state.kind === "active-here" &&
                    canSupersedeSameProcessOwner(state.lock, pid, ctx, options.instanceId, runtimeGeneration));
            if (!acquireOptions.election &&
                (state.kind === "active-here" || state.kind === "active-elsewhere") &&
                !(deliveryRevoked && hasSameLockOwner(current, expectedOwned)) &&
                (!acquireOptions.force ||
                    !expectedReplacementMatches ||
                    !canReplaceCurrent)) {
                return {
                    result: { ok: false, lock: state.lock },
                    changed: false,
                };
            }
            const journalPath = readTelegramLockJournalPath(locks[effectiveKey]) ??
                options.createJournalPath?.(ctx);
            const lock = createLockEntry(pid, ctx, {
                journalPath,
                instanceId: options.instanceId,
                busSocketPath: options.busSocketPath,
                busSecret: options.busSecret,
                mintLeaderEpoch: options.mintLeaderEpoch,
                runtimeGeneration,
            });
            locks[effectiveKey] = lock;
            ownedLockKey = effectiveKey;
            ownedLock = lock;
            deliveryRevoked = false;
            return {
                result: {
                    ok: true,
                    lock,
                    replacedStale: state.kind === "stale",
                },
                changed: true,
            };
        }),
        release: () => {
            // Withdraw local send authority even if the durable release fails.
            deliveryRevoked = true;
            return transactOwners((locks) => {
                const effectiveKey = resolveEffectiveKey();
                const state = getLockState(parseTelegramLockEntry(locks[effectiveKey]), pid, isAlive, stateOptions());
                const changed = ownedLockKey === effectiveKey &&
                    hasSameLockOwner(parseTelegramLockEntry(locks[effectiveKey]), ownedLock);
                if (changed) {
                    const journalPath = readTelegramLockJournalPath(locks[effectiveKey]);
                    if (journalPath)
                        locks[effectiveKey] = { journalPath };
                    else
                        delete locks[effectiveKey];
                    ownedLockKey = undefined;
                    ownedLock = undefined;
                }
                return { result: state, changed };
            });
        },
        getState: () => getLockState(readLock(), pid, isAlive, stateOptions()),
        getJournalPath: () => readTelegramLockJournalPath(readOwners()[resolveEffectiveKey()]),
        getStatusLabel: () => formatLockState(getLockState(readLock(), pid, isAlive, stateOptions())),
        getOwnedLeaderEpoch: () => {
            if (deliveryRevoked)
                return undefined;
            const effectiveKey = resolveEffectiveKey();
            const lock = parseTelegramLockEntry(readOwners()[effectiveKey]);
            const exactOwner = adoptCompatibleOwnedLock(effectiveKey, lock);
            return hasSameLockOwner(lock, exactOwner) ? lock?.leaderEpoch : undefined;
        },
        owns: (ctx) => {
            if (deliveryRevoked)
                return false;
            const effectiveKey = resolveEffectiveKey();
            const lock = parseTelegramLockEntry(readOwners()[effectiveKey]);
            return hasSameLockOwner(lock, adoptCompatibleOwnedLock(effectiveKey, lock, ctx));
        },
        commitIfOwned: (commit) => !deliveryRevoked &&
            transactOwners((locks) => {
                const effectiveKey = resolveEffectiveKey();
                const lock = parseTelegramLockEntry(locks[effectiveKey]);
                const exactOwner = ownedLockKey === effectiveKey && hasSameLockOwner(lock, ownedLock);
                if (!exactOwner) {
                    if (ownedLockKey === effectiveKey) {
                        ownedLockKey = undefined;
                        ownedLock = undefined;
                    }
                    return { result: false, changed: false };
                }
                commit();
                // External-file commits may retain an independent effect; never acknowledge under a changed unified owner.
                const current = !statePath ||
                    (!deliveryRevoked &&
                        hasSameLockOwner(parseTelegramLockEntry(readOwners()[effectiveKey]), ownedLock));
                return { result: current, changed: false };
            }),
        publishStateSectionIfOwned(section, mutate, publication) {
            if (section !== "workspace" && section !== "runtime")
                throw new TelegramRuntimeStateError("invalid", "Telegram owner section publication is restricted to Workspace and runtime observations.");
            if (!statePath)
                throw new TelegramRuntimeStateError("invalid", "Consolidated transport storage is not selected.");
            const profile = resolveEffectiveKey(), expected = ownedLock ? { ...ownedLock } : undefined;
            if (publication.expectedScope &&
                (publication.expectedScope.path !== statePath ||
                    publication.expectedScope.profile !== profile))
                return { committed: false };
            if (deliveryRevoked ||
                ownedLockKey !== profile ||
                !expected ||
                !publication.isCurrent())
                return { committed: false };
            const isCurrent = () => !deliveryRevoked &&
                resolveEffectiveKey() === profile &&
                ownedLockKey === profile &&
                hasSameLockOwner(ownedLock, expected) &&
                publication.isCurrent() &&
                hasSameLockOwner(parseTelegramLockEntry(readOwners()[profile]), expected);
            if (!isCurrent())
                return { committed: false };
            return mutateTelegramRuntimeStateSection(statePath, profile, section, (current, observed) => {
                assertTelegramStateTransport(observed.transport);
                if (!hasSameLockOwner(parseTelegramLockEntry(observed.transport), expected))
                    return { value: current, result: { committed: false } };
                const outcome = mutate(current, observed);
                return {
                    value: outcome.value,
                    result: { committed: true, result: outcome.result },
                };
            }, { ...publication, isCurrent });
        },
        refresh: (ctx) => {
            if (deliveryRevoked)
                return false;
            // Owner fields only, never a timestamp: liveness is proven over the bus, so an exact owner needs no write.
            const refreshedEntry = (lock) => {
                const busSecret = options.busSecret ?? lock.busSecret;
                return {
                    pid: lock.pid,
                    ...(lock.cwd ? { cwd: lock.cwd } : {}),
                    instanceId: options.instanceId,
                    leaderEpoch: lock.leaderEpoch ?? options.mintLeaderEpoch?.() ?? randomUUID(),
                    runtimeGeneration: lock.runtimeGeneration ?? runtimeGeneration,
                    ...(options.busSocketPath
                        ? { busSocketPath: options.busSocketPath }
                        : {}),
                    ...(busSecret !== undefined ? { busSecret } : {}),
                    ...(lock.journalPath ? { journalPath: lock.journalPath } : {}),
                };
            };
            // Parsed entries carry explicit `undefined` fields; compare only the published ones.
            const isCurrentEntry = (lock) => lock.leaderEpoch !== undefined &&
                isDeepStrictEqual(Object.fromEntries(Object.entries(lock).filter(([, value]) => value !== undefined)), refreshedEntry(lock));
            const effectiveKey = resolveEffectiveKey();
            const observed = readLock();
            if (observed &&
                hasSameLockOwner(observed, adoptCompatibleOwnedLock(effectiveKey, observed, ctx)) &&
                (!options.instanceId || isCurrentEntry(observed))) {
                return true;
            }
            return transactOwners((locks) => {
                const lock = parseTelegramLockEntry(locks[effectiveKey]);
                const expectedOwner = adoptCompatibleOwnedLock(effectiveKey, lock, ctx);
                if (!lock || !hasSameLockOwner(lock, expectedOwner)) {
                    if (ownedLockKey === effectiveKey) {
                        ownedLockKey = undefined;
                        ownedLock = undefined;
                    }
                    return { result: false, changed: false };
                }
                if (!options.instanceId)
                    return { result: true, changed: false };
                if (isCurrentEntry(lock))
                    return { result: true, changed: false };
                const refreshedLock = refreshedEntry(lock);
                locks[effectiveKey] = refreshedLock;
                ownedLockKey = effectiveKey;
                ownedLock = refreshedLock;
                return { result: true, changed: true };
            });
        },
    };
}
export function createTelegramLockOwnershipGuard(lock) {
    return {
        ownsContext: (ctx) => lock.owns(ctx),
    };
}
export function createTelegramDirectDeliveryOwnershipChecker(deps) {
    return () => {
        const ctx = deps.contextStore.get();
        return ctx ? deps.lock.owns(ctx) : false;
    };
}
function snapshotLockContext(ctx) {
    return { cwd: ctx.cwd };
}
export function createTelegramLockedPollingRuntime(deps) {
    let ownershipCheckInterval;
    let ownershipRefreshInterval;
    let ownershipStop;
    let activeContext;
    let ownershipCheckFailures = 0;
    let takeoverCandidate;
    let sessionAutoStartRun;
    let pollingGeneration = 0;
    let suspendedGeneration;
    let suspensionsInFlight = 0;
    let startupsInFlight = 0;
    const ownershipCheckMs = deps.ownershipCheckMs ?? TELEGRAM_OWNERSHIP_CHECK_MS;
    const ownershipRefreshMs = deps.ownershipRefreshMs ?? TELEGRAM_OWNERSHIP_REFRESH_MS;
    const stopOwnershipWatcher = () => {
        if (ownershipCheckInterval)
            clearInterval(ownershipCheckInterval);
        if (ownershipRefreshInterval)
            clearInterval(ownershipRefreshInterval);
        ownershipCheckInterval = undefined;
        ownershipRefreshInterval = undefined;
    };
    const suspendPolling = async () => {
        const generation = ++pollingGeneration;
        suspensionsInFlight += 1;
        try {
            activeContext = undefined;
            deps.transportMonitor?.stop();
            deps.stopFollowerRegistration?.();
            stopOwnershipWatcher();
            if (sessionAutoStartRun) {
                await sessionAutoStartRun;
                if (generation !== pollingGeneration)
                    return;
                deps.stopFollowerRegistration?.();
            }
            if (ownershipStop) {
                await ownershipStop;
                return;
            }
            await deps.stopPolling();
            // Unsettled starts, overlapping stops or stale completion cannot certify quiescence.
            if (generation === pollingGeneration &&
                suspensionsInFlight === 1 &&
                startupsInFlight === 0) {
                suspendedGeneration = generation;
            }
        }
        finally {
            suspensionsInFlight -= 1;
        }
    };
    const stopAfterOwnershipLoss = () => {
        if (ownershipStop)
            return;
        activeContext = undefined;
        deps.transportMonitor?.stop();
        stopOwnershipWatcher();
        deps.onTransportAvailabilityChanged?.();
        ownershipStop = deps
            .stopPolling()
            .catch((error) => deps.recordRuntimeEvent?.("lock", error, { phase: "ownership-loss" }))
            .finally(() => {
            ownershipStop = undefined;
        });
    };
    const startOwnershipWatcher = (ctx) => {
        const owner = snapshotLockContext(ctx);
        stopOwnershipWatcher();
        ownershipCheckFailures = 0;
        // A serialized "not the owner" answer is definitive and stands down at once; only an observation that
        // cannot be verified at all (both reads failed) counts toward the bounded tolerance.
        const verifyOwnership = (observe) => {
            let owned;
            let failure;
            try {
                owned = observe();
            }
            catch (error) {
                failure = error;
            }
            if (owned === true) {
                ownershipCheckFailures = 0;
                return;
            }
            if (owned === false) {
                deps.recordRuntimeEvent?.("lock", new Error("Telegram bridge ownership moved away from this instance."), { phase: "ownership-lost" });
                stopAfterOwnershipLoss();
                return;
            }
            ownershipCheckFailures += 1;
            deps.recordRuntimeEvent?.("lock", failure, {
                phase: "ownership-check-failed",
                consecutiveFailures: ownershipCheckFailures,
                tolerance: TELEGRAM_OWNERSHIP_CHECK_FAILURE_TOLERANCE,
            });
            if (ownershipCheckFailures > TELEGRAM_OWNERSHIP_CHECK_FAILURE_TOLERANCE)
                stopAfterOwnershipLoss();
        };
        ownershipCheckInterval = setInterval(() => {
            // A lock-free miss can be a strict read racing an atomic replace; refresh confirms through the serialized path.
            verifyOwnership(() => deps.lock.owns(owner) || deps.lock.refresh(owner));
        }, ownershipCheckMs);
        ownershipRefreshInterval = setInterval(() => {
            verifyOwnership(() => deps.lock.refresh(owner));
        }, ownershipRefreshMs);
        ownershipCheckInterval.unref?.();
        ownershipRefreshInterval.unref?.();
    };
    const runOwnedPollingStart = async (ctx, options, isCurrent) => {
        if (!isCurrent())
            return false;
        activeContext = ctx;
        startOwnershipWatcher(ctx);
        startupsInFlight += 1;
        try {
            if (!deps.lock.refresh(snapshotLockContext(ctx))) {
                stopOwnershipWatcher();
                return false;
            }
            await options.onAcquired?.();
            if (!isCurrent())
                return false;
            await deps.startPolling(ctx, options);
        }
        catch (error) {
            if (!isCurrent())
                return false;
            stopOwnershipWatcher();
            try {
                await deps.stopPolling();
            }
            catch (stopError) {
                deps.recordRuntimeEvent?.("lock", stopError, {
                    phase: "startup-rollback",
                });
            }
            if (!isCurrent())
                return false;
            deps.lock.release();
            deps.onTransportAvailabilityChanged?.();
            throw error;
        }
        finally {
            startupsInFlight -= 1;
        }
        if (!isCurrent())
            return false;
        if (deps.lock.owns(ctx)) {
            if (activeContext !== ctx)
                return false;
            deps.transportMonitor?.start(ctx);
            return true;
        }
        stopOwnershipWatcher();
        if (ownershipStop)
            await ownershipStop;
        if (!isCurrent())
            return false;
        await deps.stopPolling();
        if (!isCurrent())
            return false;
        deps.onTransportAvailabilityChanged?.();
        return false;
    };
    const canStartPolling = (ctx) => deps.canStartPolling?.(ctx) ?? true;
    const formatStartBlockedMessage = (ctx) => deps.formatStartBlockedMessage?.(ctx) ??
        "Telegram polling is unavailable in this Pi run mode.";
    const stop = async () => {
        const generation = pollingGeneration + 1;
        await suspendPolling();
        if (generation !== pollingGeneration)
            throw new Error("Telegram disconnect was superseded by a new connection.");
        const state = deps.lock.release();
        deps.onTransportAvailabilityChanged?.();
        if (state.kind === "active-elsewhere") {
            return `Telegram bridge is active in another Pi instance (${formatTelegramLockEntry(state.lock)}).`;
        }
        if (state.kind === "stale") {
            return `Removed stale Telegram bridge lock (${formatTelegramLockEntry(state.lock)}).`;
        }
        return "Telegram bridge disconnected.";
    };
    return {
        start: async (ctx, options = {}) => {
            if (!deps.hasBotToken()) {
                return {
                    ok: false,
                    message: deps.getBotTokenDiagnostic?.() ?? "Telegram bot is not configured.",
                };
            }
            if (!canStartPolling(ctx)) {
                return { ok: false, message: formatStartBlockedMessage(ctx) };
            }
            const cancelled = {
                ok: false,
                canTakeover: false,
                message: "Telegram polling startup was cancelled or superseded.",
            };
            if (deps.isContextCurrent?.(ctx) === false)
                return cancelled;
            const generation = ++pollingGeneration;
            const isCurrent = () => generation === pollingGeneration &&
                (deps.isContextCurrent?.(ctx) ?? true);
            if (ownershipStop)
                await ownershipStop;
            if (!isCurrent())
                return cancelled;
            if (!options.election && deps.resetDamagedState) {
                try {
                    if (deps.resetDamagedState())
                        deps.recordRuntimeEvent?.("lock", new Error("Damaged Telegram runtime state was reset; previous runtime continuity was discarded."), { phase: "state-reset" });
                }
                catch (error) {
                    deps.recordRuntimeEvent?.("lock", error, { phase: "state-reset" });
                }
            }
            let acquired = deps.lock.acquire(ctx, {
                force: options.force,
                expectedOwner: options.election?.expectedOwner ??
                    (options.force ? takeoverCandidate : undefined),
                election: options.election !== undefined,
                unresponsiveOwner: options.election?.unresponsive
                    ? options.election.expectedOwner
                    : undefined,
            });
            if (!acquired.ok && !options.election) {
                const currentState = deps.lock.getState();
                if (currentState.kind === "active-here" &&
                    hasSameLockOwner(currentState.lock, acquired.lock)) {
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
                    let failureMessage;
                    try {
                        const registered = await deps.registerFollowerWithOwner(ctx, acquired.lock);
                        if (!isCurrent())
                            return cancelled;
                        if (registered) {
                            deps.updateStatus(ctx);
                            return { ok: true, canTakeover: false };
                        }
                        if (registered === false)
                            failureMessage = "not registered";
                    }
                    catch (error) {
                        failureMessage =
                            error instanceof Error ? error.message : String(error);
                        deps.recordRuntimeEvent?.("bus", error, {
                            phase: "follower-register",
                        });
                    }
                    if (failureMessage) {
                        const unresponsiveOwner = acquired.lock;
                        if (deps.proveOwnerUnresponsive &&
                            (await deps.proveOwnerUnresponsive(unresponsiveOwner))) {
                            if (!isCurrent())
                                return cancelled;
                            acquired = deps.lock.acquire(ctx, { unresponsiveOwner });
                        }
                        if (!acquired.ok) {
                            const owner = formatTelegramLockEntry(acquired.lock);
                            return {
                                ok: false,
                                canTakeover: false,
                                owner,
                                message: `Telegram bridge is active in another Pi instance (${owner}); follower registration failed: ${formatTelegramFollowerRegistrationFailure(failureMessage)}.`,
                            };
                        }
                    }
                }
                if (!acquired.ok) {
                    const owner = formatTelegramLockEntry(acquired.lock);
                    return {
                        ok: false,
                        canTakeover: true,
                        owner,
                        message: `Telegram bridge is active in another Pi instance (${owner}).`,
                    };
                }
            }
            takeoverCandidate = undefined;
            if (!(await runOwnedPollingStart(ctx, options, isCurrent))) {
                if (!isCurrent())
                    return cancelled;
                return {
                    ok: false,
                    canTakeover: false,
                    message: "Telegram leadership changed during polling startup.",
                };
            }
            if (!isCurrent())
                return cancelled;
            deps.onTransportAvailabilityChanged?.();
            deps.updateStatus(ctx);
            const staleSuffix = acquired.replacedStale ? " Replaced stale lock." : "";
            return { ok: true, message: `Telegram bridge connected.${staleSuffix}` };
        },
        stop,
        captureStop() {
            const generation = pollingGeneration;
            const isCurrent = () => generation === pollingGeneration;
            return {
                isCurrent,
                async stop() {
                    if (!isCurrent())
                        throw new Error("Telegram disconnect was superseded by a new connection.");
                    return stop();
                },
            };
        },
        suspend: suspendPolling,
        captureTransportAuthority(ctx) {
            const generation = pollingGeneration;
            const current = () => generation === pollingGeneration &&
                activeContext === ctx &&
                !ownershipStop &&
                (deps.isContextCurrent?.(ctx) ?? true) &&
                deps.lock.owns(snapshotLockContext(ctx));
            return current() ? current : undefined;
        },
        isSuspended: () => suspendedGeneration === pollingGeneration &&
            suspensionsInFlight === 0 &&
            startupsInFlight === 0 &&
            !sessionAutoStartRun &&
            !ownershipStop,
        onPersistentConflict: async (ctx, count) => {
            if (activeContext === undefined || ownershipStop)
                return;
            if (!(deps.isContextCurrent?.(ctx) ?? activeContext === ctx))
                return;
            activeContext = undefined;
            pollingGeneration += 1;
            stopOwnershipWatcher();
            deps.transportMonitor?.stop();
            let ownership = "unverifiable";
            const cleanupErrors = [];
            try {
                ownership = deps.lock.owns(snapshotLockContext(ctx)) ? "owned" : "lost";
            }
            catch (error) {
                cleanupErrors.push(String(error));
            }
            try {
                deps.lock.release();
            }
            catch (error) {
                ownership = "unverifiable";
                cleanupErrors.push(String(error));
            }
            ownershipStop = Promise.resolve()
                .then(() => deps.stopPolling())
                .catch((error) => {
                cleanupErrors.push(String(error));
            })
                .finally(() => {
                ownershipStop = undefined;
                deps.recordRuntimeEvent?.("polling", ownership === "lost"
                    ? "Telegram transport stopped: local ownership lost; check for another Pi instance."
                    : "Telegram transport stopped: competing getUpdates client or ownership mismatch.", {
                    phase: "persistent-conflict",
                    count,
                    ownership,
                    ...(cleanupErrors.length ? { cleanupErrors } : {}),
                });
                deps.updateStatus(ctx);
            });
            deps.onTransportAvailabilityChanged?.();
            await ownershipStop;
        },
        onSessionStart: async (_event, ctx) => {
            if (!deps.hasBotToken())
                return;
            if (!canStartPolling(ctx))
                return;
            const ownsCurrentLock = deps.lock.owns(ctx);
            const state = ownsCurrentLock ? undefined : deps.lock.getState();
            const canResumeStaleSameCwd = state?.kind === "stale" && state.lock.cwd === ctx.cwd;
            const canHandoffSameProcess = state?.kind === "active-here" &&
                (!state.lock.cwd || state.lock.cwd === ctx.cwd);
            const canRestoreRememberedFollower = state?.kind === "active-elsewhere" &&
                deps.restoreFollowerWithOwner !== undefined;
            if (!ownsCurrentLock &&
                !canResumeStaleSameCwd &&
                !canHandoffSameProcess &&
                !canRestoreRememberedFollower) {
                return;
            }
            if (deps.isContextCurrent?.(ctx) === false)
                return;
            const generation = ++pollingGeneration;
            const isCurrent = () => generation === pollingGeneration &&
                (deps.isContextCurrent?.(ctx) ?? true);
            const startedAtMs = Date.now();
            deps.recordRuntimeEvent?.("lock", "Telegram auto-start scheduled", {
                phase: "auto-start-scheduled",
                mode: canRestoreRememberedFollower ? "follower-restore" : "leader",
            });
            const run = (async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (ownershipStop)
                    await ownershipStop;
                if (!isCurrent())
                    return;
                if (canRestoreRememberedFollower &&
                    state?.kind === "active-elsewhere") {
                    const restored = await deps.restoreFollowerWithOwner?.(ctx, state.lock);
                    if (!isCurrent())
                        return;
                    if (!restored) {
                        deps.recordRuntimeEvent?.("lock", "Telegram follower auto-connect did not restore this session.", { phase: "follower-auto-connect-unavailable" });
                        return;
                    }
                    deps.onTransportAvailabilityChanged?.();
                    deps.updateStatus(ctx);
                    deps.recordRuntimeEvent?.("bus", "Telegram follower auto-connect completed", { phase: "follower-auto-connect" });
                    return;
                }
                if (canResumeStaleSameCwd || canHandoffSameProcess) {
                    const acquired = deps.lock.acquire(ctx, canHandoffSameProcess
                        ? { force: true, expectedOwner: state?.lock }
                        : undefined);
                    if (!acquired.ok)
                        return;
                }
                if (!isCurrent())
                    return;
                if (!(await runOwnedPollingStart(ctx, {}, isCurrent)))
                    return;
                if (!isCurrent())
                    return;
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
                if (sessionAutoStartRun === run)
                    sessionAutoStartRun = undefined;
            });
            sessionAutoStartRun = run;
        },
        registerFollowerWithOwner: deps.registerFollowerWithOwner
            ? async (ctx, owner) => {
                const registered = await deps.registerFollowerWithOwner?.(ctx, owner);
                if (registered)
                    deps.updateStatus(ctx);
                return registered === true;
            }
            : undefined,
        restoreFollowerWithOwner: deps.restoreFollowerWithOwner
            ? async (ctx, owner) => {
                const restored = await deps.restoreFollowerWithOwner?.(ctx, owner);
                if (restored)
                    deps.updateStatus(ctx);
                return restored === true;
            }
            : undefined,
        stopFollowerRegistration: deps.stopFollowerRegistration,
    };
}
