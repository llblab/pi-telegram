/**
 * Generative application kernel and Telegram installation adapter
 * Zones: generative application state, isolated methods, pi agent tools
 * Owns Generative App identity, installation, invocation, state history, and telegram_bind
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile, } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "@sinclair/typebox";
import { renameTelegramPathWithRetry } from "./locks.js";
import { isProcessAlive } from "./process-identity.js";
const GENERATIVE_APP_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const GENERATIVE_APP_METHOD = /^[a-z][a-z0-9_]{0,31}$/u;
const GENERATIVE_APP_MAX_MODULE_BYTES = 1024 * 1024;
const GENERATIVE_APP_MAX_OUTPUT_BYTES = 64 * 1024;
const GENERATIVE_APP_MAX_STATE_BYTES = 256 * 1024;
const GENERATIVE_APP_METHOD_TIMEOUT_MS = 10_000;
const GENERATIVE_APP_LOCK_WAIT_MS = 12_000;
const GENERATIVE_APP_RUN_MAX_TIMEOUT_MS = 30_000;
const GENERATIVE_APP_RUN_MAX_ARGS = 64;
const GENERATIVE_APP_RUN_MAX_STREAM_BYTES = 64 * 1024;
export const GENERATIVE_APP_MIN_REFRESH_AFTER_MS = 2_000;
export const GENERATIVE_APP_MAX_REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
class NativeCallbackInvocation {
    #facts;
    #spent = false;
    constructor(key, facts) {
        if (key !== CALLBACK_OWNER_KEY)
            throw new Error("Generative App callback invocation is unavailable.");
        this.#facts = facts;
        Object.freeze(this);
    }
    static claim(key, value, source) {
        if (key !== CALLBACK_OWNER_KEY)
            return undefined;
        try {
            const invocation = value;
            if (invocation.#spent)
                return undefined;
            invocation.#spent = true;
            return invocation.#facts.source.owner === source?.owner ? invocation.#facts : undefined;
        }
        catch {
            return undefined;
        }
    }
    static matches(key, value, origin, owner) {
        if (key !== CALLBACK_OWNER_KEY || !origin)
            return false;
        try {
            const invocation = value;
            return invocation.#spent && invocation.#facts.source.owner === owner && Reflect.apply(readCallbackWeakRef, invocation.#facts.origin, []) === origin;
        }
        catch {
            return false;
        }
    }
}
const claimNativeCallbackInvocation = NativeCallbackInvocation.claim, matchesNativeCallbackInvocation = NativeCallbackInvocation.matches;
const NativeCallbackWeakRef = WeakRef, readCallbackWeakRef = WeakRef.prototype.deref;
const CALLBACK_OWNER_KEY = Symbol("native Generative App callback owner");
class NativeGenerativeAppCallbackBinding {
    app;
    generation;
    revision;
    assertCurrent;
    #owner;
    #appDir;
    #predecessor;
    #invocation;
    constructor(key, fields, owner, appDir, predecessor, invocation, publicationSource) {
        if (key !== CALLBACK_OWNER_KEY)
            throw new Error("Generative App callback owner is unavailable.");
        this.app = fields.app;
        this.generation = fields.generation;
        this.revision = fields.revision;
        this.#appDir = appDir;
        this.#predecessor = predecessor && new NativeCallbackWeakRef(predecessor);
        this.#invocation = invocation && new NativeCallbackWeakRef(invocation);
        const owned = { ...owner, createCallbackInvocation: (prompt, origin, authority) => {
                const action = parseGenerativeAppBoundAction(prompt);
                if (!origin || typeof origin !== "object" || !action || action.app !== this.app)
                    throw new Error("Generative App callback invocation is unavailable.");
                const current = authority?.assertCurrent, history = authority?.assertObservedCurrent;
                if (authority && (typeof current !== "function" || typeof history !== "function"))
                    throw new Error("Generative App callback invocation authority is unavailable.");
                const pinned = authority && Object.freeze({ assertCurrent: () => Reflect.apply(current, authority, []), assertObservedCurrent: () => Reflect.apply(history, authority, []) });
                this.#owner.assertCurrent();
                this.#owner.assertObservedCurrent();
                return new NativeCallbackInvocation(CALLBACK_OWNER_KEY, Object.freeze({ source: readNativeCallbackSource(CALLBACK_OWNER_KEY, this), method: action.method,
                    ...(action.argument !== undefined ? { argument: action.argument } : {}), origin: new NativeCallbackWeakRef(origin), ...(pinned ? { authority: pinned } : {}) }));
            }, captureReadOnlySuccessor: (binding, invocation, origin) => {
                const next = readNativeCallbackSource(CALLBACK_OWNER_KEY, binding, true);
                if (next?.predecessor !== this.#owner || invocation !== undefined && (next.invocation !== invocation || !matchesNativeCallbackInvocation(CALLBACK_OWNER_KEY, invocation, origin, this.#owner)))
                    return undefined;
                try {
                    this.#owner.assertCurrent();
                    next.owner.assertCurrent();
                    this.#owner.assertObservedCurrent();
                    next.owner.assertObservedCurrent();
                    return next.owner;
                }
                catch {
                    return undefined;
                }
            } };
        if (predecessor && publicationSource !== undefined)
            Object.defineProperty(owned, "originalPublicationSource", { value: publicationSource });
        this.#owner = Object.freeze(owned);
        this.assertCurrent = owner.assertCurrent;
        Object.freeze(this);
    }
    static source(key, value, withPredecessor = false) {
        if (key !== CALLBACK_OWNER_KEY)
            return undefined;
        try {
            const binding = value;
            return { appDir: binding.#appDir, app: binding.app, generation: binding.generation, revision: binding.revision, owner: binding.#owner,
                predecessor: withPredecessor && binding.#predecessor ? Reflect.apply(readCallbackWeakRef, binding.#predecessor, []) : undefined,
                invocation: withPredecessor && binding.#invocation ? Reflect.apply(readCallbackWeakRef, binding.#invocation, []) : undefined };
        }
        catch {
            return undefined;
        }
    }
    static read(key, value) {
        if (key !== CALLBACK_OWNER_KEY)
            return undefined;
        try {
            return value.#owner;
        }
        catch {
            return undefined;
        }
    }
}
const readNativeCallbackOwner = NativeGenerativeAppCallbackBinding.read;
const readNativeCallbackSource = NativeGenerativeAppCallbackBinding.source;
/** @internal Capture only an existing original native owner; foreign/copy/unavailable bindings are never probed or adopted. */
export function captureGenerativeAppCallbackOwner(binding) {
    const owner = readNativeCallbackOwner(CALLBACK_OWNER_KEY, binding);
    if (!owner)
        return undefined;
    try {
        owner.assertCurrent();
        owner.assertObservedCurrent();
        return owner;
    }
    catch {
        return undefined;
    }
}
/** @internal Historical native outcome for this exact claimed invocation; not parent or effect-execution authority. */
export function getGenerativeAppCallbackInvocationKind(binding, invocation) {
    const source = readNativeCallbackSource(CALLBACK_OWNER_KEY, binding, true);
    if (!invocation || !source || source.invocation !== invocation)
        return undefined;
    // The matching live invocation retains its original owner; absent predecessor here is not a GC observation.
    return source.predecessor ? "read-only" : "state-written";
}
/** @internal Data-only exact native refresh association; the store must authenticate its opaque source. */
export function getGenerativeAppRefreshPublicationSource(binding) {
    const native = readNativeCallbackSource(CALLBACK_OWNER_KEY, binding, true);
    if (!native?.predecessor || native.invocation !== undefined)
        return undefined;
    const source = Object.getOwnPropertyDescriptor(native.owner, "originalPublicationSource")?.value;
    return source === undefined ? undefined : Object.freeze({ source, predecessor: native.predecessor });
}
const callbackOwnerProofs = new WeakMap();
export function getGenerativeAppCallbackBinding(result) {
    const binding = callbackOwnerProofs.get(result);
    if (!binding)
        throw new Error("Generative App callback result is not native-owned.");
    return binding;
}
export function getTelegramBindLiveSurfaceKey(app, profile, target) {
    return `${app}/${profile}/${target.chatId}/${target.threadId ?? 0}`;
}
function byteLength(value) {
    return Buffer.byteLength(value, "utf8");
}
function wait(ms) {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
function assertAppName(app) {
    if (!GENERATIVE_APP_NAME.test(app)) {
        throw new Error("Generative App name must match /^[a-z][a-z0-9-]{0,31}$/.");
    }
}
function assertMethod(method) {
    if (!GENERATIVE_APP_METHOD.test(method)) {
        throw new Error("Generative App method must match /^[a-z][a-z0-9_]{0,31}$/.");
    }
}
function assertJsonValue(value, label) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
    }
    catch {
        throw new Error(`${label} must be JSON-serializable.`);
    }
    if (encoded === undefined)
        throw new Error(`${label} must be a JSON value.`);
    const parsed = JSON.parse(encoded);
    if (byteLength(encoded) > GENERATIVE_APP_MAX_STATE_BYTES) {
        throw new Error(`${label} exceeds ${GENERATIVE_APP_MAX_STATE_BYTES} bytes.`);
    }
    return parsed;
}
function getAppsRoot(agentDir) {
    return join(resolve(agentDir), "genapps");
}
async function ensureManagedAppsRoot(agentDir, create) {
    const agentRoot = resolve(agentDir);
    if (create)
        await mkdir(agentRoot, { recursive: true });
    const appsRoot = getAppsRoot(agentDir);
    try {
        const metadata = await lstat(appsRoot);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error("Generative App root must be a managed non-symlink directory.");
        }
    }
    catch (error) {
        if (error.code !== "ENOENT" || !create)
            throw error;
        await mkdir(appsRoot, { mode: 0o700 });
        const metadata = await lstat(appsRoot);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error("Generative App root must be a managed non-symlink directory.");
        }
    }
    return appsRoot;
}
export function resolveGenerativeAppDir(agentDir, app) {
    assertAppName(app);
    return join(getAppsRoot(agentDir), app);
}
export async function isGenerativeAppInstalled(agentDir, app) {
    try {
        await stat(resolveGenerativeAppModulePath(agentDir, app));
        return true;
    }
    catch {
        return false;
    }
}
export function resolveGenerativeAppModulePath(agentDir, app) {
    return join(resolveGenerativeAppDir(agentDir, app), `${app}.mjs`);
}
async function writeFileAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    // Windows may briefly deny replacing a file another reader or scanner holds; share the bounded retry.
    if (!renameTelegramPathWithRetry(temporary, path))
        throw new Error("Generative App staging file disappeared before publication.");
}
async function acquireGenerativeAppTransitionLock(appDir, waitMs = GENERATIVE_APP_LOCK_WAIT_MS) {
    const lockDir = `${appDir}.transition.lock`;
    const ownerPath = join(lockDir, "owner.json");
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    while (true) {
        try {
            await mkdir(lockDir, { mode: 0o700 });
            await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: "utf8", mode: 0o600 });
            return async () => {
                try {
                    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
                    if (owner.token === token) {
                        await rm(lockDir, { recursive: true, force: true });
                    }
                }
                catch {
                    // A missing or replaced lock is not owned by this invocation.
                }
            };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            let ownerPid;
            try {
                const owner = JSON.parse(await readFile(ownerPath, "utf8"));
                if (typeof owner.pid === "number")
                    ownerPid = owner.pid;
            }
            catch {
                // Lock publication can briefly precede owner publication.
            }
            let ownerlessStale = false;
            if (ownerPid === undefined) {
                try {
                    ownerlessStale = Date.now() - (await stat(lockDir)).mtimeMs > 1_000;
                }
                catch {
                    continue;
                }
            }
            if ((ownerPid !== undefined && !isProcessAlive(ownerPid)) ||
                ownerlessStale) {
                const reclaimDir = `${appDir}.transition.reclaim`;
                try {
                    await mkdir(reclaimDir, { mode: 0o700 });
                }
                catch (reclaimError) {
                    if (reclaimError.code !== "EEXIST") {
                        throw reclaimError;
                    }
                    await wait(25);
                    continue;
                }
                try {
                    let currentOwnerPid;
                    try {
                        const currentOwner = JSON.parse(await readFile(ownerPath, "utf8"));
                        if (typeof currentOwner.pid === "number") {
                            currentOwnerPid = currentOwner.pid;
                        }
                    }
                    catch {
                        // Re-check ownerless staleness below.
                    }
                    const currentOwnerlessStale = currentOwnerPid === undefined
                        ? await stat(lockDir)
                            .then((metadata) => Date.now() - metadata.mtimeMs > 1_000)
                            .catch(() => false)
                        : false;
                    if ((currentOwnerPid !== undefined &&
                        !isProcessAlive(currentOwnerPid)) ||
                        currentOwnerlessStale) {
                        await rm(lockDir, { recursive: true, force: true });
                    }
                }
                finally {
                    await rm(reclaimDir, { recursive: true, force: true });
                }
                continue;
            }
            if (Date.now() >= deadline) {
                throw new Error("Generative App transition is busy in another process.");
            }
            await wait(25);
        }
    }
}
async function assertGenerativeAppModule(path) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Generative App module is not a regular managed file: ${path}`);
    }
    if (metadata.size > GENERATIVE_APP_MAX_MODULE_BYTES) {
        throw new Error(`Generative App module exceeds ${GENERATIVE_APP_MAX_MODULE_BYTES} bytes.`);
    }
}
async function assertManagedAppDir(appDir) {
    const metadata = await lstat(appDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Generative App path must be a managed non-symlink directory.");
    }
}
async function readGenerativeAppGeneration(appDir) {
    await assertManagedAppDir(appDir);
    const generation = (await readFile(join(appDir, "generation"), "utf8")).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(generation)) {
        throw new Error("Generative App installation generation is invalid.");
    }
    return generation;
}
function normalizeMethodResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Generative App method must return an object.");
    }
    const result = value;
    if (typeof result.output !== "string") {
        throw new Error("Generative App method result.output must be a string.");
    }
    if (byteLength(result.output) > GENERATIVE_APP_MAX_OUTPUT_BYTES) {
        throw new Error(`Generative App output exceeds ${GENERATIVE_APP_MAX_OUTPUT_BYTES} bytes.`);
    }
    const viewMode = result.viewMode ?? "new";
    if (viewMode !== "new" && viewMode !== "edit") {
        throw new Error("Generative App viewMode must be new or edit.");
    }
    let refreshAfterMs;
    if (Object.hasOwn(result, "refreshAfterMs")) {
        if (typeof result.refreshAfterMs !== "number" ||
            !Number.isFinite(result.refreshAfterMs) ||
            !Number.isInteger(result.refreshAfterMs) ||
            result.refreshAfterMs <= 0) {
            throw new Error("Generative App refreshAfterMs must be a finite positive integer.");
        }
        refreshAfterMs = Math.min(GENERATIVE_APP_MAX_REFRESH_AFTER_MS, Math.max(GENERATIVE_APP_MIN_REFRESH_AFTER_MS, result.refreshAfterMs));
    }
    return {
        output: result.output,
        ...(refreshAfterMs !== undefined ? { refreshAfterMs } : {}),
        ...(Object.hasOwn(result, "state")
            ? { state: assertJsonValue(result.state, "Generative App state") }
            : {}),
        viewMode,
    };
}
async function readStateTimeline(appDir) {
    const path = join(appDir, "states.jsonl");
    let content;
    try {
        content = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const lines = content.split("\n");
    const envelopes = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (!parsed ||
                typeof parsed !== "object" ||
                parsed.revision !== envelopes.length ||
                typeof parsed.method !== "string" ||
                !Object.hasOwn(parsed, "state"))
                throw new Error("invalid envelope");
            parsed.state = assertJsonValue(parsed.state, "Generative App journal state");
            envelopes.push(parsed);
        }
        catch {
            const hasLaterContent = lines
                .slice(index + 1)
                .some((entry) => entry.trim());
            if (!hasLaterContent) {
                await writeFileAtomic(path, envelopes.map((envelope) => JSON.stringify(envelope)).join("\n") +
                    (envelopes.length > 0 ? "\n" : ""));
                break;
            }
            throw new Error(`Generative App state journal is corrupt at line ${index + 1}.`);
        }
    }
    return envelopes;
}
async function reconcileCurrentState(appDir, timeline) {
    const latest = timeline.at(-1)?.state;
    if (latest === undefined)
        return undefined;
    const statePath = join(appDir, "state.json");
    let current;
    try {
        current = assertJsonValue(JSON.parse(await readFile(statePath, "utf8")), "Generative App current state");
    }
    catch {
        current = undefined;
    }
    if (JSON.stringify(current) !== JSON.stringify(latest)) {
        await writeFileAtomic(statePath, `${JSON.stringify(latest, null, 2)}\n`);
    }
    return latest;
}
async function executeGenerativeAppWorker(options) {
    options.execution?.assertCurrent();
    await assertGenerativeAppModule(options.modulePath);
    if (options.callbackWorkerDrain) {
        options.execution?.assertCurrent();
        if (options.execution?.signal.aborted)
            throw new Error(`Generative App method ${options.method} was cancelled.`);
        options.callbackInvocationAuthority?.assertCurrent();
        options.callbackSource?.owner.assertCurrent();
        options.callbackSource?.owner.assertObservedCurrent();
        options.callbackInvocationAuthority?.assertObservedCurrent();
    }
    return await new Promise((resolveResult, rejectResult) => {
        const worker = new Worker(new URL("./generative-app-worker.mjs", import.meta.url), {
            execArgv: [],
            workerData: {
                argument: options.argument,
                argumentPresent: options.argument !== undefined,
                method: options.method,
                methodTimeoutMs: options.methodTimeoutMs,
                modulePath: options.modulePath,
                app: options.app,
                revision: options.revision,
                runMaxArgs: GENERATIVE_APP_RUN_MAX_ARGS,
                runMaxStreamBytes: GENERATIVE_APP_RUN_MAX_STREAM_BYTES,
                runMaxTimeoutMs: GENERATIVE_APP_RUN_MAX_TIMEOUT_MS,
                state: options.state,
                statePresent: options.state !== undefined,
            },
        });
        const terminate = options.callbackWorkerDrain ? worker.terminate : undefined;
        let settled = false;
        let terminationError;
        let terminationStarted = false, workerExited = false, terminationSettled = false;
        let pending;
        const completeDrain = () => {
            if (pending && workerExited && terminationSettled)
                finish(terminationError ?? pending.error, pending.result);
        };
        const finish = (error, result) => {
            if (settled)
                return;
            if (options.callbackWorkerDrain && !(workerExited && terminationSettled)) {
                if (pending) {
                    pending.error ??= error;
                    return;
                }
                pending = { error, result };
                terminationStarted = true;
                let termination;
                try {
                    termination = Reflect.apply(terminate, worker, []);
                }
                catch (failure) {
                    pending.error ??= failure instanceof Error ? failure : new Error("Callback worker termination failed.", { cause: failure });
                    terminationSettled = true;
                    completeDrain();
                    return;
                }
                void termination.then(() => { terminationSettled = true; completeDrain(); }, failure => { pending.error ??= failure instanceof Error ? failure : new Error("Callback worker termination failed.", { cause: failure }); terminationSettled = true; completeDrain(); });
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.execution?.signal.removeEventListener("abort", abort);
            if (error)
                rejectResult(error);
            else
                resolveResult(result);
        };
        const terminateAndFinish = () => {
            if (terminationStarted || !terminationError)
                return;
            if (options.callbackWorkerDrain) {
                finish(terminationError);
                return;
            }
            terminationStarted = true;
            void worker.terminate().then(() => finish(terminationError), () => finish(terminationError));
        };
        const requestTermination = (error) => {
            if (settled || terminationError)
                return;
            terminationError = error;
            if (pending)
                return;
            worker.postMessage({ type: "abort" });
            const forcedTermination = setTimeout(terminateAndFinish, 250);
            forcedTermination.unref?.();
        };
        const abort = () => {
            requestTermination(new Error(`Generative App method ${options.method} was cancelled.`));
        };
        const timeout = setTimeout(() => {
            requestTermination(new Error(`Generative App method timed out after ${options.methodTimeoutMs}ms.`));
        }, options.methodTimeoutMs);
        timeout.unref?.();
        options.execution?.signal.addEventListener("abort", abort, { once: true });
        worker.on("message", (message) => {
            if (terminationError) {
                if (message?.type === "abort-ack")
                    terminateAndFinish();
            }
            else if (message?.ok === true) {
                finish(undefined, message.result);
                if (!options.callbackWorkerDrain)
                    void worker.terminate();
            }
            else {
                finish(new Error(message?.error || "Generative App worker failed."));
                if (!options.callbackWorkerDrain)
                    void worker.terminate();
            }
        });
        worker.once("error", (error) => finish(terminationError ?? error));
        worker.once("exit", (code) => {
            workerExited = true;
            if (pending) {
                completeDrain();
                return;
            }
            if (terminationError)
                finish(terminationError);
            else if (!settled && code !== 0) {
                finish(new Error(`Generative App worker exited with code ${code}.`));
            }
        });
    });
}
const invocationQueues = new Map();
function serializeInvocation(key, operation) {
    const previous = invocationQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    invocationQueues.set(key, current);
    const cleanup = () => {
        if (invocationQueues.get(key) === current)
            invocationQueues.delete(key);
    };
    void current.then(cleanup, cleanup);
    return current;
}
function observeGenerativeAppOwner(options, owner) {
    try {
        options.onOwnerObserved?.(Object.freeze(owner));
    }
    catch (error) {
        try {
            options.recordRuntimeEvent?.("generative-app", error, { phase: "owner-observation", app: owner.app });
        }
        catch { }
    }
}
async function recordGenerativeAppCallbackOwner(appDir, result, predecessor, invocation, publicationSource) {
    const journal = join(appDir, "states.jsonl"), generationPath = join(appDir, "generation");
    const original = await lstat(journal, { bigint: true });
    const { app, generation, revision } = result;
    let lost = !original.isFile(), checking = false;
    const assertObservedCurrent = () => {
        if (checking)
            lost = true;
        if (lost)
            throw new Error("Generative App callback owner is unavailable.");
    };
    const assertCurrent = () => {
        if (checking) {
            lost = true;
            throw new Error("Generative App callback owner is unavailable.");
        }
        checking = true;
        try {
            if (lost)
                throw new Error("Generative App callback owner is unavailable.");
            const current = lstatSync(journal, { bigint: true });
            lost ||= !current.isFile() || current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size ||
                readFileSync(generationPath, "utf8").trim() !== generation;
            if (lost)
                throw new Error("Generative App callback owner is unavailable.");
        }
        catch {
            lost = true;
            throw new Error("Generative App callback owner is unavailable.");
        }
        finally {
            checking = false;
        }
    };
    callbackOwnerProofs.set(result, new NativeGenerativeAppCallbackBinding(CALLBACK_OWNER_KEY, { app, generation, revision }, { assertCurrent, assertObservedCurrent }, appDir, predecessor, invocation, publicationSource));
}
async function invokeMethod(options) {
    const source = options.callbackSource;
    if (source && (source.appDir !== options.appDir || source.app !== options.app ||
        options.expectedGeneration !== undefined && options.expectedGeneration !== source.generation ||
        options.expectedRevision !== undefined && options.expectedRevision !== source.revision))
        throw new Error("Generative App callback origin is unavailable.");
    options.assertCallbackOwner?.();
    source?.owner.assertCurrent();
    source?.owner.assertObservedCurrent();
    const generation = await readGenerativeAppGeneration(options.appDir);
    observeGenerativeAppOwner(options, { app: options.app, generation });
    if ((source?.generation ?? options.expectedGeneration) !== undefined &&
        (source?.generation ?? options.expectedGeneration) !== generation) {
        throw new Error(`Generative App action is stale: expected generation ${source?.generation ?? options.expectedGeneration}, current generation ${generation}.`);
    }
    const timeline = await readStateTimeline(options.appDir);
    const state = await reconcileCurrentState(options.appDir, timeline);
    if (options.method !== "init" && state === undefined) {
        throw new Error(`Generative App ${options.app} is not initialized.`);
    }
    const revision = timeline.at(-1)?.revision ?? -1;
    observeGenerativeAppOwner(options, { app: options.app, generation, revision });
    if ((source?.revision ?? options.expectedRevision) !== undefined &&
        (source?.revision ?? options.expectedRevision) !== revision) {
        throw new Error(`Generative App action is stale: expected revision ${source?.revision ?? options.expectedRevision}, current revision ${revision}.`);
    }
    source?.owner.assertCurrent();
    source?.owner.assertObservedCurrent();
    const result = normalizeMethodResult(await executeGenerativeAppWorker({
        ...(options.argument !== undefined ? { argument: options.argument } : {}),
        ...(options.execution ? { execution: options.execution } : {}),
        method: options.method,
        ...(options.callbackWorkerDrain ? { callbackWorkerDrain: true } : {}),
        ...(source ? { callbackSource: source } : {}),
        ...(options.callbackInvocationAuthority ? { callbackInvocationAuthority: options.callbackInvocationAuthority } : {}),
        methodTimeoutMs: options.methodTimeoutMs,
        modulePath: options.modulePath,
        app: options.app,
        revision,
        ...(state !== undefined ? { state } : {}),
    }));
    if (options.method === "init" && result.state === undefined) {
        throw new Error("Generative App init must return state.");
    }
    if (options.method === "refresh" && result.state !== undefined) {
        throw new Error("Generative App refresh must be output-only.");
    }
    options.assertCallbackOwner?.();
    if (options.callbackWorkerDrain)
        options.execution?.assertCurrent();
    let nextRevision = revision;
    if (result.state !== undefined) {
        options.execution?.assertCurrent();
        options.callbackInvocationAuthority?.assertCurrent();
        source?.owner.assertCurrent();
        source?.owner.assertObservedCurrent();
        options.callbackInvocationAuthority?.assertObservedCurrent();
        const envelope = {
            ...(options.argument !== undefined ? { argument: options.argument } : {}),
            method: options.method,
            revision: options.method === "init" ? 0 : revision + 1,
            state: result.state,
        };
        const encodedEnvelope = `${JSON.stringify(envelope)}\n`;
        const encodedState = `${JSON.stringify(result.state, null, 2)}\n`;
        if (options.method === "init") {
            await writeFileAtomic(join(options.appDir, "states.jsonl"), encodedEnvelope);
        }
        else {
            await appendFile(join(options.appDir, "states.jsonl"), encodedEnvelope, {
                encoding: "utf8",
                mode: 0o600,
            });
        }
        nextRevision = envelope.revision;
        observeGenerativeAppOwner(options, { app: options.app, generation, revision: nextRevision, ...(options.method === "init" ? { reset: true } : {}) });
        await writeFileAtomic(join(options.appDir, "state.json"), encodedState);
    }
    const invoked = {
        generation,
        method: options.method,
        output: result.output,
        app: options.app,
        revision: nextRevision,
        ...(result.refreshAfterMs !== undefined
            ? { refreshAfterMs: result.refreshAfterMs }
            : {}),
        stateChanged: result.state !== undefined,
        viewMode: result.viewMode ?? "new",
    };
    if (!options.staging) {
        const predecessor = result.state === undefined ? source?.owner : undefined;
        await recordGenerativeAppCallbackOwner(options.appDir, invoked, predecessor, options.callbackInvocation, options.originalPublicationSource);
        if (predecessor)
            options.callbackInvocationAuthority?.assertCurrent();
        predecessor?.assertCurrent();
        predecessor?.assertObservedCurrent();
        if (predecessor)
            options.callbackInvocationAuthority?.assertObservedCurrent();
    }
    return invoked;
}
export async function invokeGenerativeApp(options) {
    const publicationField = Object.getOwnPropertyDescriptor(options, "originalPublicationSource"), publicationSource = publicationField?.value;
    if (publicationField && !Object.hasOwn(publicationField, "value") || publicationSource !== undefined &&
        (options.method !== "refresh" || options.callbackWorkerDrain !== true || options.callbackBinding === undefined || options.callbackInvocation !== undefined || readOpaquePublicationSource(publicationSource) !== publicationSource))
        throw new Error("Generative App refresh publication source is unavailable.");
    const callbackWorkerDrain = options.callbackWorkerDrain;
    if (callbackWorkerDrain !== undefined && callbackWorkerDrain !== true)
        throw new Error("Callback worker drain must be true or omitted.");
    const originalFence = callbackWorkerDrain ? options.execution : undefined;
    const originalCheck = originalFence?.assertCurrent, originalSignal = originalFence?.signal;
    const execution = originalFence && Object.freeze({ signal: originalSignal, assertCurrent: () => Reflect.apply(originalCheck, originalFence, []) });
    const assertCallbackOwner = callbackWorkerDrain ? options.assertCallbackOwner : undefined;
    const callbackBinding = callbackWorkerDrain ? options.callbackBinding : undefined;
    const callbackSource = callbackBinding === undefined ? undefined : readNativeCallbackSource(CALLBACK_OWNER_KEY, callbackBinding);
    if (callbackBinding !== undefined && !callbackSource)
        throw new Error("Generative App callback origin is unavailable.");
    const invocationValue = callbackWorkerDrain ? options.callbackInvocation : undefined;
    if (publicationSource !== undefined && invocationValue !== undefined)
        throw new Error("Generative App refresh publication source is unavailable.");
    const invocation = invocationValue === undefined ? undefined : claimNativeCallbackInvocation(CALLBACK_OWNER_KEY, invocationValue, callbackSource);
    if (invocationValue !== undefined && !invocation)
        throw new Error("Generative App callback invocation is unavailable.");
    const scoped = !!invocation || publicationSource !== undefined;
    const app = scoped ? options.app : undefined, method = scoped ? options.method : undefined, agentDir = scoped ? options.agentDir : undefined;
    if (publicationSource !== undefined && method !== "refresh")
        throw new Error("Generative App refresh publication source is unavailable.");
    assertAppName(scoped ? app : options.app);
    assertMethod(scoped ? method : options.method);
    const argumentValue = scoped ? options.argument : undefined;
    const argument = scoped ? (argumentValue === undefined ? undefined : assertJsonValue(argumentValue, "Generative App argument")) :
        options.argument === undefined ? undefined : assertJsonValue(options.argument, "Generative App argument");
    if (invocation && (app !== invocation.source.app || method !== invocation.method || JSON.stringify(argument) !== JSON.stringify(invocation.argument)))
        throw new Error("Generative App callback invocation does not match its original prompt.");
    await ensureManagedAppsRoot(scoped ? agentDir : options.agentDir, false);
    const appDir = resolveGenerativeAppDir(scoped ? agentDir : options.agentDir, scoped ? app : options.app);
    const modulePath = resolveGenerativeAppModulePath(scoped ? agentDir : options.agentDir, scoped ? app : options.app);
    return await serializeInvocation(appDir, async () => {
        const releaseLock = await acquireGenerativeAppTransitionLock(appDir);
        try {
            return await invokeMethod({
                appDir,
                onOwnerObserved: options.onOwnerObserved, recordRuntimeEvent: options.recordRuntimeEvent,
                assertCallbackOwner: callbackWorkerDrain ? assertCallbackOwner : options.assertCallbackOwner,
                ...(callbackWorkerDrain ? { callbackWorkerDrain: true } : {}),
                ...(callbackSource ? { callbackSource } : {}),
                ...(publicationSource !== undefined ? { originalPublicationSource: publicationSource } : {}),
                ...(invocation ? { callbackInvocation: invocationValue, callbackInvocationAuthority: invocation.authority } : {}),
                ...(argument !== undefined ? { argument } : {}),
                ...(callbackWorkerDrain ? (execution ? { execution } : {}) : options.execution ? { execution: options.execution } : {}),
                ...(options.expectedGeneration !== undefined
                    ? { expectedGeneration: options.expectedGeneration }
                    : {}),
                ...(options.expectedRevision !== undefined
                    ? { expectedRevision: options.expectedRevision }
                    : {}),
                method: scoped ? method : options.method,
                methodTimeoutMs: options.methodTimeoutMs ?? GENERATIVE_APP_METHOD_TIMEOUT_MS,
                modulePath,
                app: scoped ? app : options.app,
            });
        }
        finally {
            await releaseLock();
        }
    });
}
export async function installGenerativeApp(options) {
    assertAppName(options.app);
    const sourcePath = resolve(options.script);
    if (extname(sourcePath) !== ".mjs") {
        throw new Error("Generative App installation requires a .mjs script.");
    }
    if (basename(sourcePath, ".mjs") !== options.app) {
        throw new Error("Generative App script stem must equal its app name.");
    }
    const sourceMetadata = await lstat(sourcePath);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
        throw new Error("Generative App source must be a regular non-symlink file.");
    }
    if (sourceMetadata.size > GENERATIVE_APP_MAX_MODULE_BYTES) {
        throw new Error(`Generative App module exceeds ${GENERATIVE_APP_MAX_MODULE_BYTES} bytes.`);
    }
    const appsRoot = await ensureManagedAppsRoot(options.agentDir, true);
    const appDir = resolveGenerativeAppDir(options.agentDir, options.app);
    return await serializeInvocation(appDir, async () => {
        let installed = false;
        try {
            const metadata = await lstat(appDir);
            if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
                throw new Error(`Generative App ${options.app} path is not a managed directory.`);
            }
            installed = true;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (installed && options.replace !== true) {
            throw new Error(`Generative App ${options.app} is already installed; set replace to true.`);
        }
        if (!installed && options.replace === true) {
            throw new Error(`Generative App ${options.app} is not installed and cannot be replaced.`);
        }
        const releaseLock = installed
            ? await acquireGenerativeAppTransitionLock(appDir)
            : undefined;
        const stagingDir = join(appsRoot, `.${options.app}.${process.pid}.${randomUUID()}.staging`);
        const stagingModule = join(stagingDir, `${options.app}.mjs`);
        try {
            await mkdir(stagingDir, { recursive: false, mode: 0o700 });
            await copyFile(sourcePath, stagingModule);
            await writeFile(join(stagingDir, "generation"), `${randomUUID()}\n`, {
                encoding: "utf8",
                mode: 0o600,
            });
            const argument = options.argument === undefined
                ? undefined
                : assertJsonValue(options.argument, "Generative App argument");
            const result = await invokeMethod({
                appDir: stagingDir, staging: true,
                ...(argument !== undefined ? { argument } : {}),
                ...(options.execution ? { execution: options.execution } : {}),
                method: "init",
                methodTimeoutMs: options.methodTimeoutMs ?? GENERATIVE_APP_METHOD_TIMEOUT_MS,
                modulePath: stagingModule,
                app: options.app,
            });
            if (!installed) {
                await rename(stagingDir, appDir);
                observeGenerativeAppOwner(options, { app: result.app, generation: result.generation, revision: result.revision, reset: true });
                await recordGenerativeAppCallbackOwner(appDir, result);
                return result;
            }
            const backupDir = join(appsRoot, `.${options.app}.${process.pid}.${randomUUID()}.replaced`);
            await rename(appDir, backupDir);
            try {
                await rename(stagingDir, appDir);
            }
            catch (error) {
                try {
                    await rename(backupDir, appDir);
                }
                catch (rollbackError) {
                    throw new AggregateError([error, rollbackError], `Generative App ${options.app} replacement and rollback both failed.`);
                }
                throw error;
            }
            observeGenerativeAppOwner(options, { app: result.app, generation: result.generation, revision: result.revision, reset: true });
            await recordGenerativeAppCallbackOwner(appDir, result);
            await rm(backupDir, { recursive: true, force: true });
            return result;
        }
        catch (error) {
            await rm(stagingDir, { recursive: true, force: true });
            throw error;
        }
        finally {
            await releaseLock?.();
        }
    });
}
export function parseGenerativeAppBoundAction(prompt) {
    if (!prompt.includes("::"))
        return undefined;
    const match = /^([a-z][a-z0-9-]{0,31})::([a-z][a-z0-9_]{0,31})(?:\(([\s\S]+)\))?$/u.exec(prompt);
    if (!match)
        throw new Error("Malformed Generative App bound action.");
    const [, app, method, encodedArgument] = match;
    if (!app || !method)
        throw new Error("Malformed Generative App bound action.");
    if (encodedArgument === undefined)
        return { method, app };
    let argument;
    try {
        argument = JSON.parse(encodedArgument);
    }
    catch {
        throw new Error("Generative App bound action argument must be strict JSON.");
    }
    return {
        argument: assertJsonValue(argument, "Generative App bound action argument"),
        method,
        app,
    };
}
export async function bindGenerativeApp(options) {
    const hasScript = typeof options.script === "string";
    const hasMethod = typeof options.method === "string";
    if (hasScript === hasMethod) {
        throw new Error("telegram_bind requires exactly one of script or method.");
    }
    if (!hasScript && options.replace !== undefined) {
        throw new Error("telegram_bind replace is valid only with script.");
    }
    return hasScript
        ? await installGenerativeApp({
            agentDir: options.agentDir,
            ...(options.argument !== undefined
                ? { argument: options.argument }
                : {}),
            methodTimeoutMs: options.methodTimeoutMs,
            app: options.app,
            onOwnerObserved: options.onOwnerObserved, recordRuntimeEvent: options.recordRuntimeEvent,
            replace: options.replace,
            script: options.script,
        })
        : await invokeGenerativeApp({
            agentDir: options.agentDir,
            ...(options.argument !== undefined
                ? { argument: options.argument }
                : {}),
            method: options.method,
            assertCallbackOwner: options.assertCallbackOwner,
            onOwnerObserved: options.onOwnerObserved, recordRuntimeEvent: options.recordRuntimeEvent,
            methodTimeoutMs: options.methodTimeoutMs,
            app: options.app,
        });
}
const observePublicationRejection = Promise.prototype.then;
/** Opaque transport shape only: the publication owner must authenticate it before any membership use. */
function readOpaquePublicationSource(value) {
    try {
        if (value && typeof value === "object" && Object.isFrozen(value) && typeof Object.getOwnPropertyDescriptor(value, "assertCurrent")?.value === "function")
            return value;
    }
    catch { /* Foreign capture data never becomes an assertion or publication certificate. */ }
    try {
        Reflect.apply(observePublicationRejection, value, [undefined, () => { }]);
    }
    catch { /* Only genuine rejected Promises need draining; never call a foreign then/getter. */ }
    return undefined;
}
export function createGenerativeAppLiveSurfaceRuntime(deps) {
    const records = new Map();
    const capturePublication = deps.capturePublicationSource;
    if (capturePublication !== undefined && typeof capturePublication !== "function")
        throw new TypeError("Live publication source capture must be a function or omitted.");
    const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    let active = true;
    const clearRecordTimer = (record) => {
        if (record.timer !== undefined)
            clearTimer(record.timer);
        record.timer = undefined;
    };
    const cancel = (key) => {
        const record = records.get(key);
        if (!record)
            return;
        // Drop only this record before clock callbacks; cancellation must not copy foreign surface getters.
        records.delete(key);
        clearRecordTimer(record);
    };
    const take = (key) => {
        const record = records.get(key);
        if (!record)
            return undefined;
        cancel(key);
        return { ...record.surface };
    };
    const ownsRecord = (key, record) => active && records.get(key) === record;
    const schedule = (record, delayMs) => {
        clearRecordTimer(record);
        if (!active || records.get(record.surface.key) !== record)
            return;
        const timer = setTimer(() => void refreshNow(record.surface.key), delayMs);
        record.timer = timer;
        timer.unref?.();
    };
    const captureAppSource = (surface) => {
        const field = Object.getOwnPropertyDescriptor(surface, "originalAppBinding"), binding = field?.value;
        const native = binding === undefined ? undefined : readNativeCallbackSource(CALLBACK_OWNER_KEY, binding);
        if (field && !Object.hasOwn(field, "value") || binding !== undefined && !native)
            throw new Error("Generative App live source is unavailable.");
        return native ? Object.freeze({ binding: binding, native }) : undefined;
    };
    const assertAppSourceData = (surface, source) => {
        const data = (key) => Object.getOwnPropertyDescriptor(surface, key)?.value;
        if (data("originalAppBinding") !== source.binding || data("app") !== source.native.app || data("appGeneration") !== source.native.generation || data("appRevision") !== source.native.revision)
            throw new Error("Generative App live source is unavailable.");
    };
    const assertAppSource = (record) => {
        const source = record.appSource;
        if (!source)
            return;
        if (record.appSourceLost)
            throw new Error("Generative App live source is unavailable.");
        try {
            assertAppSourceData(record.surface, source);
            source.native.owner.assertCurrent();
            source.native.owner.assertObservedCurrent();
        }
        catch (error) {
            record.appSourceLost = true;
            throw error;
        }
    };
    const refreshNow = async (key) => {
        const record = records.get(key);
        if (!active || !record || record.inFlight)
            return;
        // Pin the existing native source and reserve this record before external clock/currentness callbacks.
        const source = record.appSource;
        record.inFlight = true;
        try {
            if (source) {
                try {
                    assertAppSourceData(record.surface, source);
                }
                catch (error) {
                    record.appSourceLost = true;
                    throw error;
                }
            }
            if (!record.publicationCapture) {
                // Eligibility is separate from independent app execution. Retain even an absent capture across
                // retries; an issued snapshot stays opaque and cannot be replaced after worker/planning/I/O.
                record.publicationCapture = Object.freeze({});
                if (source && capturePublication) {
                    try {
                        const captured = readOpaquePublicationSource(Reflect.apply(capturePublication, deps, [record.surface.handle, source.binding]));
                        record.publicationCapture = Object.freeze({ ...(captured ? { source: captured } : {}) });
                    }
                    catch (error) {
                        try {
                            deps.recordRuntimeEvent?.("generative-app", error, { phase: "live-surface-publication-source", app: record.surface.app });
                        }
                        catch { }
                    }
                }
            }
            if (!ownsRecord(key, record))
                return;
            clearRecordTimer(record);
            if (!ownsRecord(key, record))
                return;
            const current = deps.isCurrent(record.surface);
            if (!ownsRecord(key, record))
                return;
            if (!current) {
                cancel(key);
                return;
            }
            assertAppSource(record);
            let pending = record.pending;
            if (!pending) {
                const result = await invokeGenerativeApp({
                    agentDir: deps.agentDir,
                    onOwnerObserved: deps.onOwnerObserved, recordRuntimeEvent: deps.recordRuntimeEvent,
                    expectedGeneration: record.surface.appGeneration,
                    expectedRevision: record.surface.appRevision,
                    ...(source ? { callbackWorkerDrain: true, callbackBinding: source.binding } : {}),
                    ...(record.publicationCapture.source ? { originalPublicationSource: record.publicationCapture.source } : {}),
                    method: "refresh",
                    app: record.surface.app,
                });
                if (!ownsRecord(key, record))
                    return;
                const current = deps.isCurrent(record.surface);
                if (!ownsRecord(key, record))
                    return;
                if (!current) {
                    cancel(key);
                    return;
                }
                assertAppSource(record);
                const frame = deps.plan(result, record.surface.handle);
                if (!ownsRecord(key, record))
                    return;
                assertAppSource(record);
                pending = { frame, result };
                if (frame.digest !== record.digest)
                    record.pending = pending;
            }
            const { frame, result } = pending;
            if (!ownsRecord(key, record))
                return;
            if (frame.digest !== record.digest) {
                record.surface.handle = await deps.edit(frame);
                if (!ownsRecord(key, record))
                    return;
                assertAppSource(record);
                record.digest = frame.digest;
                record.pending = undefined;
            }
            if (result.refreshAfterMs === undefined) {
                cancel(key);
                return;
            }
            record.publicationCapture = undefined;
            record.retryDelayMs = GENERATIVE_APP_MIN_REFRESH_AFTER_MS;
            record.surface.appRevision = result.revision;
            record.surface.refreshAfterMs = result.refreshAfterMs;
            schedule(record, result.refreshAfterMs);
        }
        catch (error) {
            const classification = deps.classifyEditError?.(error) ?? {
                kind: "unknown",
            };
            if (!ownsRecord(key, record))
                return;
            deps.recordRuntimeEvent?.("generative-app", error, {
                phase: "live-surface-refresh",
                app: record.surface.app,
                outcome: classification.kind,
            });
            const current = classification.kind === "retry" && deps.isCurrent(record.surface);
            if (!ownsRecord(key, record))
                return;
            let sourceCurrent = true;
            try {
                assertAppSource(record);
            }
            catch {
                sourceCurrent = false;
            }
            if (!current || !sourceCurrent) {
                cancel(key);
                return;
            }
            const delay = classification.retryAfterMs === undefined
                ? record.retryDelayMs
                : Math.max(GENERATIVE_APP_MIN_REFRESH_AFTER_MS, classification.retryAfterMs);
            record.retryDelayMs = Math.min(60_000, Math.max(4_000, delay * 2));
            schedule(record, delay);
        }
        finally {
            record.inFlight = false;
        }
    };
    const open = (surface) => {
        const source = captureAppSource(surface);
        const captured = { ...surface, ...(source ? { originalAppBinding: source.binding } : {}) };
        cancel(captured.key);
        if (!active || records.has(captured.key))
            return;
        const record = {
            surface: captured,
            digest: captured.initialDigest,
            inFlight: false,
            retryDelayMs: GENERATIVE_APP_MIN_REFRESH_AFTER_MS,
            ...(source ? { appSource: source } : {}),
        };
        records.set(captured.key, record);
        schedule(record, captured.refreshAfterMs);
    };
    return {
        open,
        cancel,
        take,
        async resume(surface, result) {
            if (!active)
                return;
            const original = captureAppSource(surface), key = surface.key;
            const available = () => active && !records.has(key);
            if (!available())
                return;
            const binding = original ? getGenerativeAppCallbackBinding(result) : undefined;
            const next = binding && readNativeCallbackSource(CALLBACK_OWNER_KEY, binding);
            const assertResult = () => {
                if (!original || !next)
                    return;
                assertAppSourceData(surface, original);
                if (next.app !== original.native.app || next.generation !== original.native.generation ||
                    Object.getOwnPropertyDescriptor(result, "app")?.value !== next.app || Object.getOwnPropertyDescriptor(result, "generation")?.value !== next.generation ||
                    Object.getOwnPropertyDescriptor(result, "revision")?.value !== next.revision)
                    throw new Error("Generative App live source is unavailable.");
                next.owner.assertCurrent();
                next.owner.assertObservedCurrent();
            };
            // A committed callback may replace the old app state; only its genuine current native result is reopened.
            assertResult();
            if (!available() || !deps.isCurrent(surface) || !available())
                return;
            assertResult();
            const frame = deps.plan(result, surface.handle);
            if (!available())
                return;
            assertResult();
            const handle = frame.digest === surface.initialDigest
                ? surface.handle
                : await deps.edit(frame);
            if (!available())
                return;
            assertResult();
            if (result.refreshAfterMs === undefined ||
                !deps.isCurrent({ ...surface, handle }) || !available())
                return;
            assertResult();
            open({
                ...surface,
                appGeneration: next?.generation ?? result.generation,
                appRevision: next?.revision ?? result.revision,
                ...(binding ? { originalAppBinding: binding } : {}),
                handle,
                initialDigest: frame.digest,
                refreshAfterMs: result.refreshAfterMs,
            });
        },
        refreshNow,
        shutdown() {
            active = false;
            for (const key of [...records.keys()])
                cancel(key);
        },
    };
}
export function formatGenerativeAppToolOutput(output) {
    const normalized = output.replace(/^\n+/u, "");
    return `\n${normalized || "(Generative App returned no output)"}`;
}
export function formatDisplayedGenerativeAppToolOutput() {
    return "\nGenerative App output was delivered directly to the active Telegram turn. Do not repeat, reformat, summarize, or quote it in the assistant reply.";
}
export function formatGenerativeAppToolError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`\n${message.replace(/^\n+/u, "") || "Generative App operation failed."}`);
}
// Provider tool APIs reject recursive $ref schemas (OpenAI) and raw TypeBox
// optional markers on non-builder objects (Gemini), while llama-server rejects
// unconstrained subschemas; one bounded builder-made JSON-value union satisfies all.
const TELEGRAM_BIND_JSON_ARGUMENT_MAX_DEPTH = 4;
function createTelegramBindJsonArgumentSchema(depth) {
    const scalars = [Type.Null(), Type.Boolean(), Type.Number(), Type.String()];
    if (depth <= 0)
        return Type.Union(scalars);
    const nested = createTelegramBindJsonArgumentSchema(depth - 1);
    return Type.Union([
        ...scalars,
        Type.Array(nested),
        Type.Object({}, { additionalProperties: nested }),
    ]);
}
export function registerTelegramBindTool(pi, deps) {
    const capturePublication = deps.capturePublicationSource;
    if (capturePublication !== undefined && typeof capturePublication !== "function")
        throw new TypeError("Live publication source capture must be a function or omitted.");
    const planFrame = (result, handle) => {
        const planned = deps.planOutput(result.output, {
            binding: getGenerativeAppCallbackBinding(result),
        });
        const view = {
            text: planned.markdown,
            parseMode: "markdown",
            ...(planned.replyMarkup !== undefined
                ? { replyMarkup: planned.replyMarkup }
                : {}),
        };
        return {
            digest: createHash("sha256").update(JSON.stringify(view)).digest("hex"),
            handle: { delivery: handle.delivery, view },
        };
    };
    const liveSurfaces = deps.planOutput && deps.editView && deps.isDeliveryHandleCurrent
        ? createGenerativeAppLiveSurfaceRuntime({
            agentDir: deps.agentDir,
            ...(capturePublication ? { capturePublicationSource: (handle, binding) => Reflect.apply(capturePublication, deps, [handle.delivery, binding]) } : {}),
            isCurrent: (surface) => deps.isDeliveryHandleCurrent(surface.handle.delivery),
            plan: planFrame,
            async edit(frame) {
                const view = frame.handle.view;
                if (!view)
                    throw new Error("Generative App live frame is missing its planned view.");
                const edited = await deps.editView(frame.handle.delivery, view);
                if (!edited.ok)
                    throw Object.assign(new Error(edited.message), {
                        deliveryFailureReason: edited.reason,
                        ...(edited.retryAfterMs === undefined
                            ? {}
                            : { retryAfterMs: edited.retryAfterMs }),
                    });
                return { delivery: edited.value, view };
            },
            classifyEditError(error) {
                const failure = error;
                if (failure.deliveryFailureReason === "rate-limited") {
                    return { kind: "retry", retryAfterMs: failure.retryAfterMs };
                }
                if (failure.deliveryFailureReason === "transport-retryable") {
                    return { kind: "retry" };
                }
                if (failure.deliveryFailureReason === "message-unavailable") {
                    return { kind: "unavailable" };
                }
                return {
                    kind: failure.deliveryFailureReason === "commit-unknown"
                        ? "unknown"
                        : "terminal",
                };
            },
            recordRuntimeEvent: deps.recordRuntimeEvent,
            onOwnerObserved: deps.onOwnerObserved,
            ...(deps.liveSurfaceSetTimer
                ? { setTimer: deps.liveSurfaceSetTimer }
                : {}),
            ...(deps.liveSurfaceClearTimer
                ? { clearTimer: deps.liveSurfaceClearTimer }
                : {}),
        })
        : undefined;
    deps.setLiveSurfaceRuntime?.(liveSurfaces);
    const surfaceKey = (app, handle) => getTelegramBindLiveSurfaceKey(app, deps.getActiveProfileName?.() ?? "default", handle.target);
    pi.registerTool({
        name: "telegram_bind",
        label: "Telegram Bind",
        description: "Install, explicitly replace, or invoke one named method on a managed Generative App; successful output displays directly in the active Telegram turn unless display is false.",
        parameters: Type.Object({
            app: Type.String(),
            script: Type.Optional(Type.String()),
            method: Type.Optional(Type.String()),
            replace: Type.Optional(Type.Boolean()),
            display: Type.Optional(Type.Boolean()),
            argument: Type.Optional(createTelegramBindJsonArgumentSchema(TELEGRAM_BIND_JSON_ARGUMENT_MAX_DEPTH)),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params) {
            try {
                const result = await bindGenerativeApp({
                    agentDir: deps.agentDir,
                    ...(params.argument !== undefined
                        ? { argument: params.argument }
                        : {}),
                    ...("method" in params && typeof params.method === "string"
                        ? { method: params.method }
                        : {}),
                    app: params.app,
                    ...("replace" in params && typeof params.replace === "boolean"
                        ? { replace: params.replace }
                        : {}),
                    ...("script" in params && typeof params.script === "string"
                        ? { script: params.script }
                        : {}),
                    methodTimeoutMs: deps.methodTimeoutMs,
                    onOwnerObserved: deps.onOwnerObserved, recordRuntimeEvent: deps.recordRuntimeEvent,
                });
                const activeTurn = params.display === false ? undefined : deps.getActiveTurn?.();
                if (activeTurn &&
                    deps.planOutput &&
                    (deps.sendView || deps.sendMarkdownReply)) {
                    try {
                        const planned = deps.planOutput(result.output, {
                            binding: getGenerativeAppCallbackBinding(result),
                        });
                        let messageId;
                        if (deps.sendView) {
                            const delivered = await deps.sendView({
                                text: planned.markdown,
                                parseMode: "markdown",
                                ...(planned.replyMarkup !== undefined
                                    ? { replyMarkup: planned.replyMarkup }
                                    : {}),
                            }, {
                                scope: { kind: "active-turn" },
                                replyToMessageId: activeTurn.replyToMessageId,
                            });
                            if (!delivered.ok)
                                throw new Error(delivered.message);
                            messageId = delivered.value.messageIds[0];
                            if (liveSurfaces) {
                                const key = surfaceKey(result.app, delivered.value);
                                if (result.refreshAfterMs === undefined) {
                                    liveSurfaces.cancel(key);
                                }
                                else {
                                    const handle = { delivery: delivered.value };
                                    const frame = planFrame(result, handle);
                                    liveSurfaces.open({
                                        app: result.app,
                                        appGeneration: result.generation,
                                        appRevision: result.revision,
                                        originalAppBinding: getGenerativeAppCallbackBinding(result),
                                        handle,
                                        initialDigest: frame.digest,
                                        key,
                                        refreshAfterMs: result.refreshAfterMs,
                                    });
                                }
                            }
                        }
                        else {
                            messageId = await deps.sendMarkdownReply(activeTurn.chatId, activeTurn.replyToMessageId, planned.markdown, {
                                ...(planned.replyMarkup !== undefined
                                    ? { replyMarkup: planned.replyMarkup }
                                    : {}),
                                ...(activeTurn.target ? { target: activeTurn.target } : {}),
                            });
                        }
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: formatDisplayedGenerativeAppToolOutput(),
                                },
                            ],
                            details: { ...result, displayed: true, messageId },
                        };
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("generative-app", error, {
                            phase: "bind-display",
                            app: result.app,
                            method: result.method,
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: formatGenerativeAppToolOutput(result.output),
                                },
                            ],
                            details: { ...result, displayed: false, displayFailed: true },
                        };
                    }
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: formatGenerativeAppToolOutput(result.output),
                        },
                    ],
                    details: { ...result, displayed: false },
                };
            }
            catch (error) {
                deps.recordRuntimeEvent?.("generative-app", error, {
                    phase: "bind",
                    app: params.app,
                });
                throw formatGenerativeAppToolError(error);
            }
        },
    });
}
