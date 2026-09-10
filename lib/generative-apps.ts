/**
 * Generative application kernel and Telegram installation adapter
 * Zones: generative application state, isolated methods, pi agent tools
 * Owns Generative App identity, installation, invocation, state history, and telegram_bind
 */

import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { Type } from "@sinclair/typebox";

import type { ExtensionAPI } from "./pi.ts";

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

export type GenerativeAppJsonValue =
  | null
  | boolean
  | number
  | string
  | GenerativeAppJsonValue[]
  | { [key: string]: GenerativeAppJsonValue };

export interface GenerativeAppProcessInput {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
}

export interface GenerativeAppProcessResult {
  code: number;
  killed: boolean;
  stderr: string;
  stdout: string;
}

export interface GenerativeAppMethodContext {
  argument?: GenerativeAppJsonValue;
  revision: number;
  run: (input: GenerativeAppProcessInput) => Promise<GenerativeAppProcessResult>;
  signal: AbortSignal;
  state?: GenerativeAppJsonValue;
}

export interface GenerativeAppMethodResult {
  output: string;
  state?: GenerativeAppJsonValue;
  viewMode?: "new" | "edit";
}

export interface GenerativeAppBoundAction {
  argument?: GenerativeAppJsonValue;
  method: string;
  app: string;
}

export interface GenerativeAppInvocationResult {
  generation: string;
  method: string;
  output: string;
  app: string;
  revision: number;
  stateChanged: boolean;
  viewMode: "new" | "edit";
}

interface GenerativeAppStateEnvelope {
  argument?: GenerativeAppJsonValue;
  method: string;
  revision: number;
  state: GenerativeAppJsonValue;
}

export interface GenerativeAppExecutionFence {
  assertCurrent: () => void;
  signal: AbortSignal;
}

export interface GenerativeAppRuntimeOptions {
  agentDir: string;
  execution?: GenerativeAppExecutionFence;
  methodTimeoutMs?: number;
}

export interface TelegramBindToolRegistrationDeps extends GenerativeAppRuntimeOptions {
  getActiveTurn?: () =>
    | {
        chatId: number;
        replyToMessageId: number;
        target?: { chatId: number; threadId?: number };
      }
    | undefined;
  planOutput?: (
    markdown: string,
    options: { binding: { generation: string; app: string; revision: number } },
  ) => { markdown: string; replyMarkup?: unknown };
  sendMarkdownReply?: (
    chatId: number,
    replyToMessageId: number,
    markdown: string,
    options?: {
      replyMarkup?: unknown;
      target?: { chatId: number; threadId?: number };
    },
  ) => Promise<number | undefined>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertAppName(app: string): void {
  if (!GENERATIVE_APP_NAME.test(app)) {
    throw new Error(
      "Generative App name must match /^[a-z][a-z0-9-]{0,31}$/.",
    );
  }
}

function assertMethod(method: string): void {
  if (!GENERATIVE_APP_METHOD.test(method)) {
    throw new Error(
      "Generative App method must match /^[a-z][a-z0-9_]{0,31}$/.",
    );
  }
}

function assertJsonValue(value: unknown, label: string): GenerativeAppJsonValue {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  if (encoded === undefined) throw new Error(`${label} must be a JSON value.`);
  const parsed = JSON.parse(encoded) as GenerativeAppJsonValue;
  if (byteLength(encoded) > GENERATIVE_APP_MAX_STATE_BYTES) {
    throw new Error(`${label} exceeds ${GENERATIVE_APP_MAX_STATE_BYTES} bytes.`);
  }
  return parsed;
}

function getAppsRoot(agentDir: string): string {
  return join(resolve(agentDir), "genapps");
}

async function ensureManagedAppsRoot(
  agentDir: string,
  create: boolean,
): Promise<string> {
  const agentRoot = resolve(agentDir);
  if (create) await mkdir(agentRoot, { recursive: true });
  const appsRoot = getAppsRoot(agentDir);
  try {
    const metadata = await lstat(appsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Generative App root must be a managed non-symlink directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
    await mkdir(appsRoot, { mode: 0o700 });
    const metadata = await lstat(appsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Generative App root must be a managed non-symlink directory.");
    }
  }
  return appsRoot;
}

export function resolveGenerativeAppDir(agentDir: string, app: string): string {
  assertAppName(app);
  return join(getAppsRoot(agentDir), app);
}

export function resolveGenerativeAppModulePath(
  agentDir: string,
  app: string,
): string {
  return join(resolveGenerativeAppDir(agentDir, app), `${app}.mjs`);
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function acquireGenerativeAppTransitionLock(
  appDir: string,
  waitMs = GENERATIVE_APP_LOCK_WAIT_MS,
): Promise<() => Promise<void>> {
  const lockDir = `${appDir}.transition.lock`;
  const ownerPath = join(lockDir, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, token })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return async () => {
        try {
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
            token?: unknown;
          };
          if (owner.token === token) {
            await rm(lockDir, { recursive: true, force: true });
          }
        } catch {
          // A missing or replaced lock is not owned by this invocation.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid: number | undefined;
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
          pid?: unknown;
        };
        if (typeof owner.pid === "number") ownerPid = owner.pid;
      } catch {
        // Lock publication can briefly precede owner publication.
      }
      let ownerlessStale = false;
      if (ownerPid === undefined) {
        try {
          ownerlessStale = Date.now() - (await stat(lockDir)).mtimeMs > 1_000;
        } catch {
          continue;
        }
      }
      if (
        (ownerPid !== undefined && !isProcessAlive(ownerPid)) ||
        ownerlessStale
      ) {
        const reclaimDir = `${appDir}.transition.reclaim`;
        try {
          await mkdir(reclaimDir, { mode: 0o700 });
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw reclaimError;
          }
          await wait(25);
          continue;
        }
        try {
          let currentOwnerPid: number | undefined;
          try {
            const currentOwner = JSON.parse(
              await readFile(ownerPath, "utf8"),
            ) as { pid?: unknown };
            if (typeof currentOwner.pid === "number") {
              currentOwnerPid = currentOwner.pid;
            }
          } catch {
            // Re-check ownerless staleness below.
          }
          const currentOwnerlessStale = currentOwnerPid === undefined
            ? await stat(lockDir)
                .then((metadata) => Date.now() - metadata.mtimeMs > 1_000)
                .catch(() => false)
            : false;
          if (
            (currentOwnerPid !== undefined && !isProcessAlive(currentOwnerPid)) ||
            currentOwnerlessStale
          ) {
            await rm(lockDir, { recursive: true, force: true });
          }
        } finally {
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

async function assertGenerativeAppModule(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Generative App module is not a regular managed file: ${path}`);
  }
  if (metadata.size > GENERATIVE_APP_MAX_MODULE_BYTES) {
    throw new Error(`Generative App module exceeds ${GENERATIVE_APP_MAX_MODULE_BYTES} bytes.`);
  }
}

async function assertManagedAppDir(appDir: string): Promise<void> {
  const metadata = await lstat(appDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Generative App path must be a managed non-symlink directory.");
  }
}

async function readGenerativeAppGeneration(appDir: string): Promise<string> {
  await assertManagedAppDir(appDir);
  const generation = (await readFile(join(appDir, "generation"), "utf8")).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(generation)) {
    throw new Error("Generative App installation generation is invalid.");
  }
  return generation;
}

function normalizeMethodResult(value: unknown): GenerativeAppMethodResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Generative App method must return an object.");
  }
  const result = value as Record<string, unknown>;
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
  return {
    output: result.output,
    ...(Object.hasOwn(result, "state")
      ? { state: assertJsonValue(result.state, "Generative App state") }
      : {}),
    viewMode,
  };
}

async function readStateTimeline(appDir: string): Promise<GenerativeAppStateEnvelope[]> {
  const path = join(appDir, "states.jsonl");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = content.split("\n");
  const envelopes: GenerativeAppStateEnvelope[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as GenerativeAppStateEnvelope;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.revision !== envelopes.length ||
        typeof parsed.method !== "string" ||
        !Object.hasOwn(parsed, "state")
      ) throw new Error("invalid envelope");
      parsed.state = assertJsonValue(parsed.state, "Generative App journal state");
      envelopes.push(parsed);
    } catch {
      const hasLaterContent = lines.slice(index + 1).some((entry) => entry.trim());
      if (!hasLaterContent) {
        await writeFileAtomic(
          path,
          envelopes.map((envelope) => JSON.stringify(envelope)).join("\n") +
            (envelopes.length > 0 ? "\n" : ""),
        );
        break;
      }
      throw new Error(`Generative App state journal is corrupt at line ${index + 1}.`);
    }
  }
  return envelopes;
}

async function reconcileCurrentState(
  appDir: string,
  timeline: GenerativeAppStateEnvelope[],
): Promise<GenerativeAppJsonValue | undefined> {
  const latest = timeline.at(-1)?.state;
  if (latest === undefined) return undefined;
  const statePath = join(appDir, "state.json");
  let current: GenerativeAppJsonValue | undefined;
  try {
    current = assertJsonValue(
      JSON.parse(await readFile(statePath, "utf8")),
      "Generative App current state",
    );
  } catch {
    current = undefined;
  }
  if (JSON.stringify(current) !== JSON.stringify(latest)) {
    await writeFileAtomic(statePath, `${JSON.stringify(latest, null, 2)}\n`);
  }
  return latest;
}

async function executeGenerativeAppWorker(options: {
  argument?: GenerativeAppJsonValue;
  execution?: GenerativeAppExecutionFence;
  method: string;
  methodTimeoutMs: number;
  modulePath: string;
  app: string;
  revision: number;
  state?: GenerativeAppJsonValue;
}): Promise<unknown> {
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
    let terminationError: Error | undefined;
    let terminationStarted = false;
    const finish = (error?: unknown, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.execution?.signal.removeEventListener("abort", abort);
      if (error) rejectResult(error);
      else resolveResult(result);
    };
    const terminateAndFinish = (): void => {
      if (terminationStarted || !terminationError) return;
      terminationStarted = true;
      void worker.terminate().then(
        () => finish(terminationError),
        () => finish(terminationError),
      );
    };
    const requestTermination = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      worker.postMessage({ type: "abort" });
      const forcedTermination = setTimeout(terminateAndFinish, 250);
      forcedTermination.unref?.();
    };
    const abort = (): void => {
      requestTermination(
        new Error(`Generative App method ${options.method} was cancelled.`),
      );
    };
    const timeout = setTimeout(() => {
      requestTermination(
        new Error(
          `Generative App method timed out after ${options.methodTimeoutMs}ms.`,
        ),
      );
    }, options.methodTimeoutMs);
    timeout.unref?.();
    options.execution?.signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: {
      error?: string;
      ok?: boolean;
      result?: unknown;
      type?: string;
    }) => {
      if (terminationError) {
        if (message?.type === "abort-ack") terminateAndFinish();
      } else if (message?.ok === true) {
        finish(undefined, message.result);
        void worker.terminate();
      } else {
        finish(new Error(message?.error || "Generative App worker failed."));
        void worker.terminate();
      }
    });
    worker.once("error", (error) => finish(terminationError ?? error));
    worker.once("exit", (code) => {
      if (terminationError) finish(terminationError);
      else if (!settled && code !== 0) {
        finish(new Error(`Generative App worker exited with code ${code}.`));
      }
    });
  });
}

const invocationQueues = new Map<string, Promise<unknown>>();

function serializeInvocation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = invocationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  invocationQueues.set(key, current);
  const cleanup = (): void => {
    if (invocationQueues.get(key) === current) invocationQueues.delete(key);
  };
  void current.then(cleanup, cleanup);
  return current;
}

async function invokeMethod(options: {
  appDir: string;
  argument?: GenerativeAppJsonValue;
  execution?: GenerativeAppExecutionFence;
  expectedGeneration?: string;
  expectedRevision?: number;
  method: string;
  methodTimeoutMs: number;
  modulePath: string;
  app: string;
}): Promise<GenerativeAppInvocationResult> {
  const generation = await readGenerativeAppGeneration(options.appDir);
  if (
    options.expectedGeneration !== undefined &&
    options.expectedGeneration !== generation
  ) {
    throw new Error(
      `Generative App action is stale: expected generation ${options.expectedGeneration}, current generation ${generation}.`,
    );
  }
  const timeline = await readStateTimeline(options.appDir);
  const state = await reconcileCurrentState(options.appDir, timeline);
  if (options.method !== "init" && state === undefined) {
    throw new Error(`Generative App ${options.app} is not initialized.`);
  }
  const revision = timeline.at(-1)?.revision ?? -1;
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== revision
  ) {
    throw new Error(
      `Generative App action is stale: expected revision ${options.expectedRevision}, current revision ${revision}.`,
    );
  }
  const result = normalizeMethodResult(
    await executeGenerativeAppWorker({
      ...(options.argument !== undefined ? { argument: options.argument } : {}),
      ...(options.execution ? { execution: options.execution } : {}),
      method: options.method,
      methodTimeoutMs: options.methodTimeoutMs,
      modulePath: options.modulePath,
      app: options.app,
      revision,
      ...(state !== undefined ? { state } : {}),
    }),
  );
  if (options.method === "init" && result.state === undefined) {
    throw new Error("Generative App init must return state.");
  }
  let nextRevision = revision;
  if (result.state !== undefined) {
    options.execution?.assertCurrent();
    const envelope: GenerativeAppStateEnvelope = {
      ...(options.argument !== undefined ? { argument: options.argument } : {}),
      method: options.method,
      revision: options.method === "init" ? 0 : revision + 1,
      state: result.state,
    };
    const encodedEnvelope = `${JSON.stringify(envelope)}\n`;
    const encodedState = `${JSON.stringify(result.state, null, 2)}\n`;
    if (options.method === "init") {
      await writeFileAtomic(join(options.appDir, "states.jsonl"), encodedEnvelope);
    } else {
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
    stateChanged: result.state !== undefined,
    viewMode: result.viewMode ?? "new",
  };
}

export async function invokeGenerativeApp(options: GenerativeAppRuntimeOptions & {
  argument?: unknown;
  expectedGeneration?: string;
  expectedRevision?: number;
  method: string;
  app: string;
}): Promise<GenerativeAppInvocationResult> {
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
    } finally {
      await releaseLock();
    }
  });
}

export async function installGenerativeApp(options: GenerativeAppRuntimeOptions & {
  argument?: unknown;
  app: string;
  replace?: boolean;
  script: string;
}): Promise<GenerativeAppInvocationResult> {
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    const stagingDir = join(
      appsRoot,
      `.${options.app}.${process.pid}.${randomUUID()}.staging`,
    );
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
      const backupDir = join(
        appsRoot,
        `.${options.app}.${process.pid}.${randomUUID()}.replaced`,
      );
      await rename(appDir, backupDir);
      try {
        await rename(stagingDir, appDir);
      } catch (error) {
        try {
          await rename(backupDir, appDir);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Generative App ${options.app} replacement and rollback both failed.`,
          );
        }
        throw error;
      }
      await rm(backupDir, { recursive: true, force: true });
      return result;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    } finally {
      await releaseLock?.();
    }
  });
}

export function parseGenerativeAppBoundAction(
  prompt: string,
): GenerativeAppBoundAction | undefined {
  if (!prompt.includes("::")) return undefined;
  const match = /^([a-z][a-z0-9-]{0,31})::([a-z][a-z0-9_]{0,31})(?:\(([\s\S]+)\))?$/u.exec(
    prompt,
  );
  if (!match) throw new Error("Malformed Generative App bound action.");
  const [, app, method, encodedArgument] = match;
  if (!app || !method) throw new Error("Malformed Generative App bound action.");
  if (encodedArgument === undefined) return { method, app };
  let argument: unknown;
  try {
    argument = JSON.parse(encodedArgument);
  } catch {
    throw new Error("Generative App bound action argument must be strict JSON.");
  }
  return {
    argument: assertJsonValue(argument, "Generative App bound action argument"),
    method,
    app,
  };
}

export async function invokeGenerativeAppBoundAction(
  options: GenerativeAppRuntimeOptions & {
    expectedGeneration?: string;
    expectedRevision?: number;
    prompt: string;
  },
): Promise<GenerativeAppInvocationResult | undefined> {
  const action = parseGenerativeAppBoundAction(options.prompt);
  if (!action) return undefined;
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

export async function bindGenerativeApp(options: GenerativeAppRuntimeOptions & {
  argument?: unknown;
  method?: string;
  app: string;
  replace?: boolean;
  script?: string;
}): Promise<GenerativeAppInvocationResult> {
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
        script: options.script!,
      })
    : await invokeGenerativeApp({
        agentDir: options.agentDir,
        ...(options.argument !== undefined ? { argument: options.argument } : {}),
        method: options.method!,
        methodTimeoutMs: options.methodTimeoutMs,
        app: options.app,
      });
}

export function formatGenerativeAppToolOutput(output: string): string {
  const normalized = output.replace(/^\n+/u, "");
  return `\n${normalized || "(Generative App returned no output)"}`;
}

export function formatDisplayedGenerativeAppToolOutput(): string {
  return "\nGenerative App output was delivered directly to the active Telegram turn. Do not repeat, reformat, summarize, or quote it in the assistant reply.";
}

export function formatGenerativeAppToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`\n${message.replace(/^\n+/u, "") || "Generative App operation failed."}`);
}

const TELEGRAM_BIND_JSON_ARGUMENT_REFERENCE = "#/$defs/TelegramBindJsonValue";
const TELEGRAM_BIND_JSON_ARGUMENT_SCHEMA = {
  $ref: TELEGRAM_BIND_JSON_ARGUMENT_REFERENCE,
} as unknown as ReturnType<typeof Type.Unknown>;
const TELEGRAM_BIND_JSON_ARGUMENT_DEFINITION = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { $ref: TELEGRAM_BIND_JSON_ARGUMENT_REFERENCE } },
    { type: "object", properties: {},
      additionalProperties: { $ref: TELEGRAM_BIND_JSON_ARGUMENT_REFERENCE } },
  ],
};

export function registerTelegramBindTool(
  pi: ExtensionAPI,
  deps: TelegramBindToolRegistrationDeps,
): void {
  pi.registerTool({
    name: "telegram_bind",
    label: "Telegram Bind",
    description:
      "Install, explicitly replace, or invoke one named method on a managed Generative App; successful output displays directly in the active Telegram turn unless display is false.",
    parameters: Type.Object({
      app: Type.String(),
      script: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      replace: Type.Optional(Type.Boolean()),
      display: Type.Optional(Type.Boolean()),
      argument: Type.Optional(TELEGRAM_BIND_JSON_ARGUMENT_SCHEMA),
    }, { additionalProperties: false,
      $defs: { TelegramBindJsonValue: TELEGRAM_BIND_JSON_ARGUMENT_DEFINITION },
    }),
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
        if (activeTurn && deps.planOutput && deps.sendMarkdownReply) {
          try {
            const planned = deps.planOutput(result.output, {
              binding: {
                generation: result.generation,
                app: result.app,
                revision: result.revision,
              },
            });
            const messageId = await deps.sendMarkdownReply(
              activeTurn.chatId,
              activeTurn.replyToMessageId,
              planned.markdown,
              {
                ...(planned.replyMarkup !== undefined
                  ? { replyMarkup: planned.replyMarkup }
                  : {}),
                ...(activeTurn.target ? { target: activeTurn.target } : {}),
              },
            );
            return {
              content: [{ type: "text", text: formatDisplayedGenerativeAppToolOutput() }],
              details: { ...result, displayed: true, messageId },
            };
          } catch (error) {
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
      } catch (error) {
        deps.recordRuntimeEvent?.("generative-app", error, {
          phase: "bind",
          app: params.app,
        });
        throw formatGenerativeAppToolError(error);
      }
    },
  });
}
