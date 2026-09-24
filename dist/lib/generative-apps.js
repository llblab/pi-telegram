/**
 * Generative application kernel and Telegram installation adapter
 * Zones: generative application state, isolated methods, pi agent tools
 * Owns Generative App identity, installation, invocation, state history, and telegram_bind
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile, } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "@sinclair/typebox";
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
export function getTelegramBindLiveSurfaceKey(app, profile, target) {
    return `${app}/${profile}/${target.chatId}/${target.threadId ?? 0}`;
}
function byteLength(value) {
    return Buffer.byteLength(value, "utf8");
}
function wait(ms) {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
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
export function resolveGenerativeAppModulePath(agentDir, app) {
    return join(resolveGenerativeAppDir(agentDir, app), `${app}.mjs`);
}
async function writeFileAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
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
                    if ((currentOwnerPid !== undefined && !isProcessAlive(currentOwnerPid)) ||
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
            const hasLaterContent = lines.slice(index + 1).some((entry) => entry.trim());
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
        let settled = false;
        let terminationError;
        let terminationStarted = false;
        const finish = (error, result) => {
            if (settled)
                return;
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
            terminationStarted = true;
            void worker.terminate().then(() => finish(terminationError), () => finish(terminationError));
        };
        const requestTermination = (error) => {
            if (settled || terminationError)
                return;
            terminationError = error;
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
                void worker.terminate();
            }
            else {
                finish(new Error(message?.error || "Generative App worker failed."));
                void worker.terminate();
            }
        });
        worker.once("error", (error) => finish(terminationError ?? error));
        worker.once("exit", (code) => {
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
async function invokeMethod(options) {
    const generation = await readGenerativeAppGeneration(options.appDir);
    if (options.expectedGeneration !== undefined &&
        options.expectedGeneration !== generation) {
        throw new Error(`Generative App action is stale: expected generation ${options.expectedGeneration}, current generation ${generation}.`);
    }
    const timeline = await readStateTimeline(options.appDir);
    const state = await reconcileCurrentState(options.appDir, timeline);
    if (options.method !== "init" && state === undefined) {
        throw new Error(`Generative App ${options.app} is not initialized.`);
    }
    const revision = timeline.at(-1)?.revision ?? -1;
    if (options.expectedRevision !== undefined &&
        options.expectedRevision !== revision) {
        throw new Error(`Generative App action is stale: expected revision ${options.expectedRevision}, current revision ${revision}.`);
    }
    const result = normalizeMethodResult(await executeGenerativeAppWorker({
        ...(options.argument !== undefined ? { argument: options.argument } : {}),
        ...(options.execution ? { execution: options.execution } : {}),
        method: options.method,
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
    let nextRevision = revision;
    if (result.state !== undefined) {
        options.execution?.assertCurrent();
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
        await writeFileAtomic(join(options.appDir, "state.json"), encodedState);
        nextRevision = envelope.revision;
    }
    return {
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
}
export async function invokeGenerativeApp(options) {
    assertAppName(options.app);
    assertMethod(options.method);
    const argument = options.argument === undefined
        ? undefined
        : assertJsonValue(options.argument, "Generative App argument");
    await ensureManagedAppsRoot(options.agentDir, false);
    const appDir = resolveGenerativeAppDir(options.agentDir, options.app);
    const modulePath = resolveGenerativeAppModulePath(options.agentDir, options.app);
    return await serializeInvocation(appDir, async () => {
        const releaseLock = await acquireGenerativeAppTransitionLock(appDir);
        try {
            return await invokeMethod({
                appDir,
                ...(argument !== undefined ? { argument } : {}),
                ...(options.execution ? { execution: options.execution } : {}),
                ...(options.expectedGeneration !== undefined
                    ? { expectedGeneration: options.expectedGeneration }
                    : {}),
                ...(options.expectedRevision !== undefined
                    ? { expectedRevision: options.expectedRevision }
                    : {}),
                method: options.method,
                methodTimeoutMs: options.methodTimeoutMs ?? GENERATIVE_APP_METHOD_TIMEOUT_MS,
                modulePath,
                app: options.app,
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
                appDir: stagingDir,
                ...(argument !== undefined ? { argument } : {}),
                ...(options.execution ? { execution: options.execution } : {}),
                method: "init",
                methodTimeoutMs: options.methodTimeoutMs ?? GENERATIVE_APP_METHOD_TIMEOUT_MS,
                modulePath: stagingModule,
                app: options.app,
            });
            if (!installed) {
                await rename(stagingDir, appDir);
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
export async function invokeGenerativeAppBoundAction(options) {
    const action = parseGenerativeAppBoundAction(options.prompt);
    if (!action)
        return undefined;
    return await invokeGenerativeApp({
        agentDir: options.agentDir,
        ...(action.argument !== undefined ? { argument: action.argument } : {}),
        ...(options.expectedGeneration !== undefined
            ? { expectedGeneration: options.expectedGeneration }
            : {}),
        ...(options.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
        method: action.method,
        methodTimeoutMs: options.methodTimeoutMs,
        app: action.app,
    });
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
            ...(options.argument !== undefined ? { argument: options.argument } : {}),
            methodTimeoutMs: options.methodTimeoutMs,
            app: options.app,
            replace: options.replace,
            script: options.script,
        })
        : await invokeGenerativeApp({
            agentDir: options.agentDir,
            ...(options.argument !== undefined ? { argument: options.argument } : {}),
            method: options.method,
            methodTimeoutMs: options.methodTimeoutMs,
            app: options.app,
        });
}
export function createGenerativeAppLiveSurfaceRuntime(deps) {
    const records = new Map();
    const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    let active = true;
    const clearRecordTimer = (record) => {
        if (record.timer !== undefined)
            clearTimer(record.timer);
        record.timer = undefined;
    };
    const take = (key) => {
        const record = records.get(key);
        if (!record)
            return undefined;
        clearRecordTimer(record);
        records.delete(key);
        return { ...record.surface };
    };
    const cancel = (key) => {
        take(key);
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
    const refreshNow = async (key) => {
        const record = records.get(key);
        if (!active || !record || record.inFlight)
            return;
        clearRecordTimer(record);
        if (!deps.isCurrent(record.surface)) {
            cancel(key);
            return;
        }
        record.inFlight = true;
        try {
            let pending = record.pending;
            if (!pending) {
                const result = await invokeGenerativeApp({
                    agentDir: deps.agentDir,
                    expectedGeneration: record.surface.appGeneration,
                    expectedRevision: record.surface.appRevision,
                    method: "refresh",
                    app: record.surface.app,
                });
                if (!ownsRecord(key, record) || !deps.isCurrent(record.surface)) {
                    if (records.get(key) === record)
                        cancel(key);
                    return;
                }
                const frame = deps.plan(result, record.surface.handle);
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
                record.digest = frame.digest;
                record.pending = undefined;
            }
            if (result.refreshAfterMs === undefined) {
                cancel(key);
                return;
            }
            record.retryDelayMs = GENERATIVE_APP_MIN_REFRESH_AFTER_MS;
            record.surface.appRevision = result.revision;
            record.surface.refreshAfterMs = result.refreshAfterMs;
            schedule(record, result.refreshAfterMs);
        }
        catch (error) {
            const classification = deps.classifyEditError?.(error) ?? { kind: "unknown" };
            if (!ownsRecord(key, record))
                return;
            deps.recordRuntimeEvent?.("generative-app", error, {
                phase: "live-surface-refresh",
                app: record.surface.app,
                outcome: classification.kind,
            });
            if (classification.kind !== "retry" || !deps.isCurrent(record.surface)) {
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
        cancel(surface.key);
        if (!active)
            return;
        const record = {
            surface: { ...surface },
            digest: surface.initialDigest,
            inFlight: false,
            retryDelayMs: GENERATIVE_APP_MIN_REFRESH_AFTER_MS,
        };
        records.set(surface.key, record);
        schedule(record, surface.refreshAfterMs);
    };
    return {
        open,
        cancel,
        take,
        async resume(surface, result) {
            if (!active || !deps.isCurrent(surface))
                return;
            const frame = deps.plan(result, surface.handle);
            const handle = frame.digest === surface.initialDigest
                ? surface.handle
                : await deps.edit(frame);
            if (result.refreshAfterMs === undefined || !deps.isCurrent({ ...surface, handle }))
                return;
            open({
                ...surface,
                appGeneration: result.generation,
                appRevision: result.revision,
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
    const planFrame = (result, handle) => {
        const planned = deps.planOutput(result.output, {
            binding: {
                generation: result.generation,
                app: result.app,
                revision: result.revision,
            },
        });
        const view = {
            text: planned.markdown,
            parseMode: "markdown",
            ...(planned.replyMarkup !== undefined ? { replyMarkup: planned.replyMarkup } : {}),
        };
        return {
            digest: createHash("sha256").update(JSON.stringify(view)).digest("hex"),
            handle: { delivery: handle.delivery, view },
        };
    };
    const liveSurfaces = deps.planOutput && deps.editView && deps.isDeliveryHandleCurrent
        ? createGenerativeAppLiveSurfaceRuntime({
            agentDir: deps.agentDir,
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
                        ...(edited.retryAfterMs === undefined ? {} : { retryAfterMs: edited.retryAfterMs }),
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
                    kind: failure.deliveryFailureReason === "commit-unknown" ? "unknown" : "terminal",
                };
            },
            recordRuntimeEvent: deps.recordRuntimeEvent,
            ...(deps.liveSurfaceSetTimer ? { setTimer: deps.liveSurfaceSetTimer } : {}),
            ...(deps.liveSurfaceClearTimer ? { clearTimer: deps.liveSurfaceClearTimer } : {}),
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
                    ...(params.argument !== undefined ? { argument: params.argument } : {}),
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
                });
                const activeTurn = params.display === false
                    ? undefined
                    : deps.getActiveTurn?.();
                if (activeTurn && deps.planOutput && (deps.sendView || deps.sendMarkdownReply)) {
                    try {
                        const planned = deps.planOutput(result.output, {
                            binding: {
                                generation: result.generation,
                                app: result.app,
                                revision: result.revision,
                            },
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
                            content: [{ type: "text", text: formatDisplayedGenerativeAppToolOutput() }],
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
                            content: [{ type: "text", text: formatGenerativeAppToolOutput(result.output) }],
                            details: { ...result, displayed: false, displayFailed: true },
                        };
                    }
                }
                return {
                    content: [{ type: "text", text: formatGenerativeAppToolOutput(result.output) }],
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
