/**
 * Cross-domain integration tests for the Telegram extension
 * Exercises extension-level polling, queue/lifecycle wiring, previews, reactions, compaction, and model switching
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitForTimeout } from "node:timers/promises";
import testRoot, { mock, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { registerTelegramActivityHandler } from "../api/activity.ts";
import { createTelegramActivityVerbosityRuntime } from "../lib/activity-verbosity.ts";
import * as AgentMessages from "../lib/agent-messages.ts";
import * as BusApi from "../lib/bus-api.ts";
import * as BusFollower from "../lib/bus-follower.ts";
import * as BusLeader from "../lib/bus-leader.ts";
import * as Bus from "../lib/bus.ts";
import * as Delivery from "../lib/delivery.ts";
import * as Routing from "../lib/routing.ts";
import * as Threads from "../lib/threads.ts";
import * as Journal from "../lib/journal.ts";
import * as Locks from "../lib/locks.ts";
import * as Queue from "../lib/queue.ts";
import * as Updates from "../lib/updates.ts";
import {
  createTelegramBridgeApiRuntime,
  type TelegramApiClient,
  type TelegramBridgeApiRuntime,
} from "../lib/telegram-api.ts";

type RuntimeTestHandler = (context: TestContext) => void | Promise<void>;
type RuntimeTelegramExtension = (typeof import("../index.ts"))["default"];

function test(
  name: string,
  fn: RuntimeTestHandler,
  timeoutMs = 5_000,
): void {
  void testRoot(name, { concurrency: false, timeout: timeoutMs }, fn);
}

let runtimeTelegramExtension: RuntimeTelegramExtension | undefined;
let runtimeAgentDir: string | undefined;

const queueOwnerWorkerPath = fileURLToPath(
  new URL("./fixtures/queue-owner-worker.ts", import.meta.url),
);

interface QueueOwnerTransportHandoffInput {
  journalPath: string;
  recipientJournalPath: string;
  ownersPath: string;
  socketPath: string;
  authSecret: string;
  donorInstanceId: string;
  donorCwd: string;
  recipientInstanceId: string;
  recipientProfileKey: string;
  recipientRegistrationGeneration: string;
  target: { chatId: number; threadId: number };
  dropHandoffAck?: boolean;
}

interface QueueOwnerTransportHandoffProcess {
  child: ReturnType<typeof spawn>;
  ready: Promise<{
    phase: "ready";
    pid: number;
    processBirthId: string;
    transportOwned: boolean;
    executionCount: number;
    foreignQueuedCount: number;
    recipientJournalBindingKey: string;
  }>;
  stop: (command?: "stop" | "execute-control") => Promise<{
    phase: "stopped";
    executionCount: number;
    foreignQueuedCount: number;
    donorEntryCount: number;
    recipientEntryCount: number;
    recipientQueueCount: number;
    handoffCount: number;
    controlExecutions: string[];
    droppedHandoffAck: boolean;
  }>;
}

function spawnQueueOwnerTransportHandoffProcess(
  input: QueueOwnerTransportHandoffInput,
): QueueOwnerTransportHandoffProcess {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      queueOwnerWorkerPath,
      input.journalPath,
      "transport-handoff",
      JSON.stringify(input),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  let stderr = "";
  const lines: unknown[] = [];
  let wake: (() => void) | undefined;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) lines.push(JSON.parse(line));
      wake?.();
      wake = undefined;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let closed: { exitCode: number | null } | undefined;
  child.once("close", (exitCode) => {
    closed = { exitCode };
    wake?.();
    wake = undefined;
  });
  const nextLine = async <T>(): Promise<T> => {
    while (lines.length === 0) {
      if (closed) {
        throw new Error(
          `queue owner transport worker exited ${closed.exitCode}: ${stderr}`,
        );
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return lines.shift() as T;
  };
  return {
    child,
    ready: nextLine(),
    async stop(command = "stop") {
      child.stdin.write(`${command}\n`);
      const result = await nextLine<{
        phase: "stopped";
        executionCount: number;
        foreignQueuedCount: number;
        donorEntryCount: number;
        recipientEntryCount: number;
        recipientQueueCount: number;
        handoffCount: number;
        controlExecutions: string[];
        droppedHandoffAck: boolean;
      }>();
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
      return result;
    },
  };
}

interface RegistrationRecoveryRaceResult {
  phase: "result";
  registrationOk: boolean;
  recoveryStatus: string;
  registeredPid: number;
  registeredProcessBirthId: string;
  ownerAlive: boolean;
  journalState: string;
  journalOwnerPid: number;
}

function runRegistrationRecoveryRaceProcess(input: {
  journalPath: string;
  socketPath: string;
  startPath: string;
  instanceId: string;
  profileKey: string;
  registrationGeneration: string;
  target: { chatId: number; threadId: number };
}): Promise<RegistrationRecoveryRaceResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        queueOwnerWorkerPath,
        input.journalPath,
        "registration-recovery-race",
        JSON.stringify(input),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let buffer = "";
    let stderr = "";
    let started = false;
    let result: RegistrationRecoveryRaceResult | undefined;
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { phase?: string };
        if (message.phase === "ready" && !started) {
          started = true;
          void writeFile(input.startPath, "start", "utf8").catch(reject);
        } else if (message.phase === "result") {
          result = message as RegistrationRecoveryRaceResult;
          child.kill("SIGKILL");
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (result) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `registration recovery worker exited ${exitCode ?? signal}: ${stderr}`,
        ),
      );
    });
  });
}

function runQueueOwnerReplacementProcess(
  path: string,
  mode: "observe" | "recover" = "observe",
): Promise<{
  executionCount: number;
  foreignQueuedCount: number;
  queuedClaimCount: number;
  entryCount: number;
  directCompletionError?: string;
  recoveryStatus?: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", queueOwnerWorkerPath, path, mode],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new Error(
            `queue owner replacement exited ${exitCode}: ${stderr}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as {
          executionCount: number;
          foreignQueuedCount: number;
          queuedClaimCount: number;
          entryCount: number;
          directCompletionError?: string;
          recoveryStatus?: string;
        });
      } catch (error) {
        reject(
          new Error(`queue owner replacement returned invalid JSON: ${stdout}`, {
            cause: error,
          }),
        );
      }
    });
  });
}

async function ensureRuntimeAgentDir(): Promise<string> {
  if (!runtimeAgentDir) {
    runtimeAgentDir = await mkdtemp(
      join(tmpdir(), "pi-telegram-runtime-agent-"),
    );
    process.env.PI_CODING_AGENT_DIR = runtimeAgentDir;
  }
  return runtimeAgentDir;
}

async function getRuntimeTelegramExtension(): Promise<RuntimeTelegramExtension> {
  if (runtimeTelegramExtension) return runtimeTelegramExtension;
  await ensureRuntimeAgentDir();
  runtimeTelegramExtension = (await import("../index.ts")).default;
  return runtimeTelegramExtension;
}

test("Cross-instance agent turns route in both leader and follower directions", async () => {
  const followerRegistry = Bus.createTelegramBusFollowerRegistry();
  followerRegistry.register({
    instanceId: "follower",
    connectedAtMs: 1,
    registrationGeneration: "follower-generation",
    target: { chatId: 7, threadId: 99 },
    threadName: "Birch",
  });
  const events: string[] = [];
  const handleUpdate = async (update: Updates.TelegramUpdateFlow) => {
    await Updates.executeTelegramUpdate(update, 7, {
      ctx: "ctx",
      getCurrentInstanceId: () => "leader",
      getMessageOwnership: () => ({ instanceId: "source-instance" }),
      getTargetOwnership: (target) =>
        target.threadId === 99
          ? {
              instanceId: "follower",
              ownerGeneration: "follower-generation",
            }
          : { instanceId: "leader" },
      recordMessageOwnership: ({ instanceId, messageId }) => {
        events.push(`record:${instanceId}:${messageId}`);
      },
      foreignOwnedUpdateForwarder: {
        forwardMessage: async ({ message, ownership }) => {
          events.push(
            `forward:${ownership.instanceId}:${ownership.ownerGeneration}:${message.message_thread_id}:${message.pi_telegram_agent_source_thread}`,
          );
          return {
            status: "accepted",
            delivery: {
              deliveryId: "test-delivery",
              sourceUpdateId: 1,
              recipientBindingKey: "test-recipient",
            },
          };
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async (message) => {
        events.push(
          `local:${message.message_thread_id}:${message.pi_telegram_agent_source_thread}`,
        );
      },
      handleAuthorizedTelegramEditedMessage: async () => {},
    });
  };
  const runtime = AgentMessages.createTelegramAgentMessageRuntime({
    instanceId: "leader",
    getAllowedChatId: () => 7,
    getLeaderTarget: () => ({ chatId: 7, threadId: 42 }),
    getLeaderThreadName: () => "Aster",
    followerRegistry,
    getContext: () => "ctx",
    handleUpdate,
  });

  await runtime.route({
    sourceTarget: { chatId: 7, threadId: 42 },
    sourceThreadName: "Aster",
    message: {
      target: { chatId: 7, threadId: 99 },
      messageId: 101,
      text: "Leader to follower",
    },
  });
  await runtime.route({
    sourceTarget: { chatId: 7, threadId: 99 },
    sourceThreadName: "Birch",
    message: {
      target: { chatId: 7, threadId: 42 },
      messageId: 102,
      text: "Follower to leader",
    },
  });

  assert.deepEqual(events, [
    "record:follower:101",
    "forward:follower:follower-generation:99:Aster",
    "local:42:Birch",
  ]);
});

async function flushMicrotasks(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

async function waitForEventLoopCondition(
  predicate: () => boolean,
  iterations = 1_000,
): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for event-loop condition");
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (predicate()) return;
  throw new Error("Timed out waiting for condition");
}

async function waitForAsyncCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (await predicate()) return;
  throw new Error("Timed out waiting for async condition");
}

function parseJsonRequestBody(
  init: RequestInit | undefined,
): Record<string, unknown> | undefined {
  if (typeof init?.body !== "string") return undefined;
  return JSON.parse(init.body) as Record<string, unknown>;
}

function getRuntimeTelegramApiMethod(input: string | URL | Request): string {
  const url = typeof input === "string" ? input : input.toString();
  return url.split("/").at(-1) ?? "";
}

async function getRuntimeIntegrationDiagnostics(
  methods: Array<{ method: string; body?: Record<string, unknown> }>,
): Promise<string> {
  const agentDir = await ensureRuntimeAgentDir();
  const runtimeDir = join(agentDir, "tmp", "telegram");
  const readOptional = async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      return `<unavailable: ${error instanceof Error ? error.message : String(error)}>`;
    }
  };
  const [state, logs, ownersText] = await Promise.all([
    readOptional(join(runtimeDir, "state.json")),
    readOptional(join(runtimeDir, "logs.jsonl")),
    readOptional(join(runtimeDir, "owners.json")),
  ]);
  let owner: Record<string, unknown> | string = ownersText;
  try {
    const parsed = JSON.parse(ownersText) as Record<string, Record<string, unknown>>;
    const current = parsed.default;
    owner = current
      ? {
          pid: current.pid,
          cwd: current.cwd,
          acquiredAtMs: current.acquiredAtMs,
          heartbeatAtMs: current.heartbeatAtMs,
          leaderEpoch: current.leaderEpoch,
        }
      : {};
  } catch {
    /* preserve unreadable owner evidence */
  }
  return JSON.stringify({ methods, owner, state, logs }, null, 2);
}

function getRuntimeTelegramApiText(
  body: Record<string, unknown> | undefined,
): string {
  const richMessage = body?.rich_message as
    | { html?: string; markdown?: string }
    | undefined;
  return String(body?.text ?? richMessage?.html ?? richMessage?.markdown ?? "");
}

function setRuntimeTestFetch(fetchImpl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function createRuntimeTelegramConfigFixture() {
  const agentDir = await ensureRuntimeAgentDir();
  const configPath = join(agentDir, "telegram.json");
  const previousConfig = await readFile(configPath, "utf8").catch(
    () => undefined,
  );
  const isolated = process.env.PI_CODING_AGENT_DIR === agentDir;
  return {
    write: async (config: Record<string, unknown>) => {
      await mkdir(agentDir, { recursive: true });
      const telegramTempDir = join(agentDir, "tmp", "telegram");
      const tempEntries = await readdir(telegramTempDir).catch(() => []);
      await Promise.all(
        tempEntries
          .filter((entry) => entry.startsWith("inbox"))
          .map((entry) =>
            rm(join(telegramTempDir, entry), {
              recursive: true,
              force: true,
            }),
          ),
      );
      const assistant =
        typeof config.assistant === "object" && config.assistant !== null
          ? (config.assistant as Record<string, unknown>)
          : {};
      await writeFile(
        configPath,
        JSON.stringify(
          {
            ...config,
            assistant: {
              activity: "quiet",
              timeInjection: "hidden",
              ...assistant,
            },
          },
          null,
          "\t",
        ) + "\n",
        "utf8",
      );
    },
    restore: async () => {
      if (isolated) return;
      if (previousConfig === undefined) {
        await rm(configPath, { force: true });
        return;
      }
      await writeFile(configPath, previousConfig, "utf8");
    },
  };
}

async function writeRuntimeTelegramLocks(
  locks: Record<string, unknown>,
): Promise<void> {
  const agentDir = await ensureRuntimeAgentDir();
  const telegramRuntimeDir = join(agentDir, "tmp", "telegram");
  await mkdir(telegramRuntimeDir, { recursive: true });
  await writeFile(
    join(telegramRuntimeDir, "owners.json"),
    JSON.stringify(locks, null, "\t") + "\n",
    "utf8",
  );
}

async function stageRuntimeV02712Artifacts(): Promise<string | undefined> {
  const agentDir = await ensureRuntimeAgentDir();
  const telegramRuntimeDir = join(agentDir, "tmp", "telegram");
  await mkdir(telegramRuntimeDir, { recursive: true });
  await writeFile(
    join(telegramRuntimeDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      source: "snapshot",
      writtenAtMs: 0,
      bot: { threadMode: "enabled" },
      identities: [],
      reservations: [],
      pendingProvisions: [],
      pendingCleanups: [],
      syncObservations: [],
      threads: [],
    })}\n`,
    "utf8",
  );
  if (process.platform === "win32") return undefined;
  const busPath = Bus.resolveTelegramBusSocketPath(
    Bus.getTelegramBusSocketPath(agentDir, process.platform),
    process.platform,
  );
  await rm(busPath, { force: true });
  await symlink(".pt-v02712-missing.sock", busPath);
  return busPath;
}

function createRuntimeDeferredResponse() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createRuntimeTelegramApiResponse(result: unknown): Response {
  return { json: async () => ({ ok: true, result }) } as Response;
}

function createRuntimeTelegramApiErrorResponse(
  status: number,
  description: string,
): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ "retry-after": "0" }),
    text: async () => JSON.stringify({ ok: false, description }),
  } as Response;
}

function createRuntimeExtensionContext(
  overrides: Record<string, unknown> = {},
) {
  return {
    hasUI: true,
    cwd: process.cwd(),
    model: undefined,
    signal: undefined,
    ui: {
      theme: {
        fg: (_token: string, text: string) => text,
      },
      setStatus: () => {},
      notify: () => {},
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    ...overrides,
  };
}

type RuntimeModelFixture = {
  provider: string;
  id: string;
  reasoning?: boolean;
};

function createRuntimeModel(
  provider: string,
  id: string,
  reasoning?: boolean,
): RuntimeModelFixture {
  return reasoning === undefined
    ? { provider, id }
    : { provider, id, reasoning };
}

type RuntimeModelContextOptions = {
  model?: RuntimeModelFixture;
  availableModels: RuntimeModelFixture[];
  isIdle?: () => boolean;
  abort?: () => void;
  setStatus?: (slot: string, text: string) => void;
};

function createRuntimeModelContext(options: RuntimeModelContextOptions) {
  return createRuntimeExtensionContext({
    cwd: process.cwd(),
    model: options.model,
    ui: {
      theme: {
        fg: (_token: string, text: string) => text,
      },
      setStatus: options.setStatus ?? (() => {}),
      notify: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      refresh: () => {},
      getAvailable: () => options.availableModels,
      isUsingOAuth: () => false,
    },
    getContextUsage: () => undefined,
    isIdle: options.isIdle ?? (() => true),
    abort: options.abort ?? (() => {}),
  });
}

type RuntimeHarnessTextBlock = { type: string; text?: string };
type RuntimeHarnessMessage = string | RuntimeHarnessTextBlock[];

function getRuntimeHarnessTextBlock(
  content: RuntimeHarnessMessage | undefined,
): RuntimeHarnessTextBlock {
  assert.equal(Array.isArray(content), true);
  if (!Array.isArray(content)) throw new Error("Expected text-block message");
  return content[0] ?? { type: "" };
}

function getRuntimeHarnessMessageText(content: RuntimeHarnessMessage): string {
  if (typeof content === "string") return content;
  return getRuntimeHarnessTextBlock(content).text ?? "";
}

function recordRuntimeDispatchEvent(
  events: string[],
  content: RuntimeHarnessMessage,
): void {
  events.push(`dispatch:${getRuntimeHarnessMessageText(content)}`);
}

type RuntimeHarnessHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
type RuntimeHarnessCommand = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};
type RuntimePiHarnessOptions = {
  sendMessage?: (message: unknown, options?: unknown) => void;
  sendUserMessage?: (content: RuntimeHarnessMessage) => void;
  activeTools?: string[];
  getThinkingLevel?: () => string;
  setModel?: (model: { provider: string; id: string }) => Promise<boolean>;
  setThinkingLevel?: (level: string) => void;
  getCommands?: () => unknown[];
};

function createRuntimePiHarness(options: RuntimePiHarnessOptions = {}) {
  const handlers = new Map<string, RuntimeHarnessHandler>();
  const commands = new Map<string, RuntimeHarnessCommand>();
  let activeTools = [...(options.activeTools ?? ["read", "foreign_tool"])];
  const pi = {
    on: (event: string, handler: RuntimeHarnessHandler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, definition: RuntimeHarnessCommand) => {
      commands.set(name, definition);
    },
    registerTool: (definition: { name: string }) => {
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    sendMessage: options.sendMessage ?? (() => {}),
    sendUserMessage: options.sendUserMessage ?? (() => {}),
    getCommands: options.getCommands ?? (() => []),
    getThinkingLevel: options.getThinkingLevel ?? (() => "medium"),
    ...(options.setModel ? { setModel: options.setModel } : {}),
    ...(options.setThinkingLevel
      ? { setThinkingLevel: options.setThinkingLevel }
      : {}),
  };
  return {
    handlers,
    commands,
    pi: pi as never,
    getActiveTools: () => [...activeTools],
  };
}

test("v0.27.12 artifacts and graceful tab cleanup preserve same-directory auto-connect ownership", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const { handlers, commands, pi } = createRuntimePiHarness();
  const methods: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    methods.push({ method, ...(body ? { body } : {}) });
    if (method === "deleteWebhook" || method === "setMyCommands") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getMe") {
      return createRuntimeTelegramApiResponse({
        id: 123,
        username: "test_bot",
        has_topics_enabled: true,
      });
    }
    if (method === "getUpdates") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("stop", "AbortError"));
        });
      });
    }
    if (method === "createForumTopic") {
      return createRuntimeTelegramApiResponse({
        message_thread_id: 42,
        name: "Atlas",
      });
    }
    if (
      method === "sendMessage" ||
      method === "closeForumTopic" ||
      method === "deleteForumTopic"
    ) {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      botId: 123,
      botUsername: "test_bot",
      allowedUserId: 77,
      lastUpdateId: 0,
      threads: { automaticCleanup: true },
    });
    await writeRuntimeTelegramLocks({});
    const legacyBusPath = await stageRuntimeV02712Artifacts();
    const runtimeAgentPath = await ensureRuntimeAgentDir();
    const journalPath = join(runtimeAgentPath, "tmp", "telegram", "inbox.json");
    const journal = Journal.createTelegramUpdateJournalStore({
      path: journalPath,
      botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
        botToken: "123:abc",
        botId: 123,
      }),
    });
    journal.appendBatch([
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 77, type: "private" },
          from: { id: 77, is_bot: false, first_name: "Owner" },
          text: "recover admitted authority",
        },
      },
    ]);
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({ cwd: "/repo/graceful-leader" });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(
      () => methods.some((entry) => entry.method === "createForumTopic"),
      10_000,
    );
    assert.deepEqual(
      journal.read().entries.map((entry) => entry.updateId),
      [1],
      "upgrade startup must preserve pre-existing journal authority",
    );
    if (legacyBusPath) {
      try {
        await waitForAsyncCondition(async () => {
          try {
            return (await readlink(legacyBusPath)) !== ".pt-v02712-missing.sock";
          } catch {
            return true;
          }
        }, 20_000);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${await getRuntimeIntegrationDiagnostics(methods)}`,
        );
      }
    }

    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );

    const agentDir = await ensureRuntimeAgentDir();
    const ownersAfterQuit = JSON.parse(
      await readFile(join(agentDir, "tmp", "telegram", "owners.json"), "utf8"),
    ) as Record<string, { pid?: number; cwd?: string }>;
    assert.equal(ownersAfterQuit.default?.pid, process.pid);
    assert.equal(ownersAfterQuit.default?.cwd, "/repo/graceful-leader");

    const restartedCtx = createRuntimeExtensionContext({
      cwd: "/repo/graceful-leader",
    });
    await handlers.get("session_start")?.({}, restartedCtx);
    try {
      await waitForCondition(
        () =>
          methods.filter((entry) => entry.method === "createForumTopic").length >=
          2,
        40_000,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${await getRuntimeIntegrationDiagnostics(methods)}`,
      );
    }
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      restartedCtx,
    );

    const deleteCall = methods.find(
      (entry) => entry.method === "deleteForumTopic",
    );
    assert.deepEqual(deleteCall?.body, {
      chat_id: 77,
      message_thread_id: 42,
    }, deleteCall ? undefined : await getRuntimeIntegrationDiagnostics(methods));
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
}, 60_000);

test("Graceful follower disconnect persists intent and deletes through its live leader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-follower-cleanup-integration-"));
  const socketPath = join(dir, "bus.sock");
  const store = Threads.createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  const registry = Bus.createTelegramBusFollowerRegistry();
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  const disconnectFollower =
    BusLeader.createTelegramBusFollowerDisconnectHandler({
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { ok: true } as TResponse;
      },
      getCurrentLeaderEpoch: () => 7,
      getSyncState: () => syncState,
      setSyncState: (state) => {
        syncState = state;
      },
      getNowMs: () => 2000,
      recordRuntimeEvent: () => undefined,
    });
  const server = Bus.createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: BusLeader.createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      authSecret: "leader-secret",
      protocolIdentity: Bus.createTelegramBusProtocolIdentity({
        runtimeBuild: "test",
      }),
      getNowMs: () => 2000,
      async provisionFollowerTarget(registration) {
        store.upsert({
          profileKey: registration.profileKey ?? "manual:follower-a",
          owner: {
            kind: "manual-follower",
            instanceId: registration.instanceId,
          },
          target: { chatId: 77, threadId: 43 },
          status: "active",
          createdAtMs: 1900,
          updatedAtMs: 1900,
          instanceId: registration.instanceId,
          slot: "B",
          threadName: "Beacon",
        });
        await store.persist();
        return {
          chatId: 77,
          threadId: 43,
          slot: "B",
          threadName: "Beacon",
        };
      },
      onFollowerDisconnected: disconnectFollower,
      getCurrentLeaderEpoch: () => 7,
    }),
  });
  let requestSequence = 0;
  const follower = BusFollower.createTelegramBusFollowerRegistrationRuntime({
    instanceId: "follower-a",
    createRequestId: () => `follower-a:${++requestSequence}`,
    protocolIdentity: Bus.createTelegramBusProtocolIdentity({
      runtimeBuild: "test",
    }),
    getLeaderAuthSecret: (leader) => leader.busSecret,
    getNowMs: () => 2000,
    registrationTimeoutMs: 5_000,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo/follower-a" },
        { busSocketPath: socketPath, busSecret: "leader-secret" },
      ),
      true,
    );
    assert.equal(await follower.disconnectFromLeader?.(), true);

    assert.deepEqual(calls, [
      {
        method: "closeForumTopic",
        body: { chat_id: 77, message_thread_id: 43 },
      },
      {
        method: "deleteForumTopic",
        body: { chat_id: 77, message_thread_id: 43 },
      },
    ]);
    assert.equal(registry.get("follower-a"), undefined);
    assert.equal(store.getActiveByInstanceId("follower-a"), undefined);
    assert.deepEqual(store.listPendingCleanups(), []);
  } finally {
    follower.stop();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Public activity delivery reaches the classic instance without blocking agent start", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const { handlers, commands, pi } = createRuntimePiHarness();
  const activitySend = createRuntimeDeferredResponse();
  const sentBodies: Array<Record<string, unknown>> = [];
  let activityHandledCount = 0;
  let unregisterActivity: (() => void) | undefined;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook" || method === "setMyCommands") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("stop", "AbortError"));
        });
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendMessage") {
      sentBodies.push(body ?? {});
      if (body?.text === "Activity from local") return activitySend.promise;
      return createRuntimeTelegramApiResponse({ message_id: 90 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      botId: 123,
      botUsername: "test_bot",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    unregisterActivity = registerTelegramActivityHandler({
      id: "integration-classic-activity",
      handle: async (event, activityCtx) => {
        if (event.type !== "agent-start") return;
        await activityCtx.send({ text: "Activity from local" });
        activityHandledCount += 1;
      },
    });

    await handlers.get("input")?.({ source: "interactive" }, ctx);
    await handlers.get("agent_start")?.({}, ctx);
    await waitForEventLoopCondition(() =>
      sentBodies.some((body) => body.text === "Activity from local"),
    );
    assert.equal(
      activityHandledCount,
      0,
      "agent_start must not await extension-owned activity delivery",
    );
    const activityBody = sentBodies.find(
      (body) => body.text === "Activity from local",
    );
    assert.equal(activityBody?.chat_id, 77);
    assert.equal(activityBody?.message_thread_id, undefined);

    activitySend.resolve(
      createRuntimeTelegramApiResponse({ message_id: 91 }),
    );
    await waitForEventLoopCondition(() => activityHandledCount === 1);
    await handlers.get("agent_settled")?.({}, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("input")?.({ source: "interactive" }, ctx);
    await handlers.get("agent_start")?.({}, ctx);
    await waitForEventLoopCondition(() => activityHandledCount === 2);
    await handlers.get("agent_settled")?.({}, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    unregisterActivity?.();
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Verbose activity reaches classic transport before the final assistant answer", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const { handlers, commands, pi } = createRuntimePiHarness();
  const calls: Array<{
    method: string;
    body: Record<string, unknown>;
  }> = [];
  let nextMessageId = 100;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init) ?? {};
    if (method === "deleteWebhook" || method === "setMyCommands") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("stop", "AbortError"));
        });
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    calls.push({ method, body });
    if (method === "sendRichMessageDraft" || method === "editMessageText") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      return createRuntimeTelegramApiResponse({
        message_id: nextMessageId++,
      });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      assistant: {
        activity: "verbose",
        proactivePush: true,
      },
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/verbose-classic",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await handlers.get("input")?.(
      { source: "interactive", text: "verbose probe" },
      ctx,
    );
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("message_update")?.(
      {
        message: {},
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "provider-exposed reasoning",
        },
      },
      ctx,
    );
    for (const [toolCallId, toolName] of [
      ["one", "read"],
      ["two", "exec"],
    ] as const) {
      await handlers.get("tool_execution_start")?.(
        {
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args: { path: `${toolCallId}.txt` },
        },
        ctx,
      );
      await handlers.get("tool_execution_end")?.(
        {
          type: "tool_execution_end",
          toolCallId,
          toolName,
          result: `${toolCallId} result`,
          isError: false,
        },
        ctx,
      );
    }
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Semantic **answer**" }],
    };
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Semantic **answer**",
          partial: assistantMessage,
        },
      },
      ctx,
    );
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "done",
          reason: "stop",
          message: assistantMessage,
        },
      },
      ctx,
    );
    await handlers.get("agent_end")?.(
      { messages: [assistantMessage] },
      ctx,
    );
    await waitForCondition(() =>
      calls.some((call) => {
        const richMessage = call.body.rich_message as
          | { markdown?: string }
          | undefined;
        return richMessage?.markdown?.includes("Semantic **answer**") ?? false;
      }),
    );

    const thinkingIndex = calls.findIndex(
      (call) =>
        call.method === "sendMessage" &&
        typeof call.body.text === "string" &&
        call.body.text.includes("<blockquote expandable>") &&
        !call.body.text.includes("Thinking:"),
    );
    assert.equal(calls[thinkingIndex]?.body.chat_id, 77);
    const toolSendIndex = calls.findIndex(
      (call) =>
        call.method === "sendRichMessage" &&
        JSON.stringify(call.body.rich_message).includes("Read:") &&
        JSON.stringify(call.body.rich_message).includes("details"),
    );
    const toolEditIndex = calls.findIndex(
      (call) =>
        call.method === "editMessageText" &&
        JSON.stringify(call.body.rich_message).includes("Exec:") &&
        JSON.stringify(call.body.rich_message).includes("details"),
    );
    const finalIndex = calls.findIndex((call) => {
      const richMessage = call.body.rich_message as
        | { markdown?: string }
        | undefined;
      return richMessage?.markdown?.includes("Semantic **answer**") ?? false;
    });
    assert.ok(thinkingIndex >= 0);
    assert.ok(toolSendIndex > thinkingIndex);
    assert.ok(
      toolEditIndex > toolSendIndex,
      JSON.stringify(calls, undefined, 2),
    );
    assert.ok(finalIndex > toolEditIndex);
    const editedRich = JSON.stringify(
      calls[toolEditIndex]?.body.rich_message,
    );
    assert.match(editedRich, /Read/);
    assert.match(editedRich, /Exec/);
    assert.match(editedRich, /arguments/);
    assert.match(editedRich, /result/);
    assert.equal(calls[toolEditIndex]?.body.text, undefined);
    await handlers.get("agent_settled")?.({}, ctx);
    await commands.get("telegram-disconnect")?.handler("", ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Verbose activity uses follower transport and loses stale registration authority", async () => {
  let followerGeneration = "follower-1";
  const followerCalls: Array<{
    operation: string;
    args: unknown[];
  }> = [];
  const directRuntime = createTelegramBridgeApiRuntime({
    client: {
      call: async <TResponse>() => {
        return Promise.reject(
          new Error("Direct transport must not be used by a follower."),
        ) as Promise<TResponse>;
      },
      callMultipart: async <TResponse>() => {
        return Promise.reject(
          new Error("Multipart transport is not expected."),
        ) as Promise<TResponse>;
      },
      downloadFile: async () => "/tmp/file",
      answerCallbackQuery: async () => {},
    } satisfies TelegramApiClient,
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {},
  });
  const api = BusApi.createTelegramBusAwareApiRuntime({
    directRuntime,
    ownsDirect: () => false,
    getDefaultTarget: () => ({ chatId: 77, threadId: 43 }),
    async callFollowerApi(operation: string, args: unknown[]) {
      followerCalls.push({ operation, args });
      const method = args[0];
      return method === "sendMessage" || method === "sendRichMessage"
        ? { message_id: 501 }
        : true;
    },
  });
  const authority = Routing.createTelegramAssistantOutputAuthorityRuntime({
    getPreferredTarget: () => ({ chatId: 77, threadId: 43 }),
    getFallbackChatId: () => 77,
    getTransportStamp: () => "profile-1",
    isTransportStampActive: (stamp) => stamp === "profile-1",
    ownsDirect: () => false,
    getDirectEpoch: () => undefined,
    isFollowerRegistered: () => followerGeneration !== "",
    getFollowerGeneration: () => followerGeneration || undefined,
  });
  const runtime = createTelegramActivityVerbosityRuntime({
    getActivityMode: () => "verbose",
    resolveTarget: () => ({ chatId: 77, threadId: 43 }),
    captureAuthority: authority.captureAuthority,
    isAuthorityActive: authority.isAuthorityActive,
    sendMessage: api.sendMessage,
    sendRichMessage: api.sendRichMessage,
    editMessageText: api.editMessageText,
  });
  const base = {
    activityId: "follower-activity",
    source: "telegram",
    target: { chatId: 77, threadId: 43 },
    timestamp: 1,
  } as const;
  runtime.accept({ ...base, sequence: 1, type: "agent-start" });
  runtime.accept({
    ...base,
    sequence: 2,
    type: "reasoning-delta",
    contentIndex: 0,
    delta: "follower reasoning",
  });
  runtime.accept({
    ...base,
    sequence: 3,
    type: "tool-end",
    toolCallId: "tool-1",
    toolName: "read",
    result: "done",
    isError: false,
  });
  await runtime.waitForIdle();
  assert.deepEqual(
    followerCalls.map((call) => call.args[0]),
    ["sendMessage", "sendRichMessage"],
  );
  const thinkingBody = followerCalls[0]?.args[1] as
    | Record<string, unknown>
    | undefined;
  assert.equal(thinkingBody?.chat_id, 77);
  assert.equal(thinkingBody?.message_thread_id, 43);

  followerGeneration = "follower-2";
  runtime.accept({
    ...base,
    sequence: 4,
    type: "tool-end",
    toolCallId: "tool-2",
    toolName: "exec",
    result: "stale",
    isError: false,
  });
  await runtime.waitForIdle();
  assert.equal(followerCalls.length, 2);
  runtime.stop();
});

test("Follower aggregate delivery crosses the authorized leader transport", async () => {
  const follower = {
    instanceId: "follower-one",
    connectedAtMs: 1,
    lastHeartbeatMs: 1,
    target: { chatId: 77, threadId: 12 },
  };
  const directBodies: Array<Record<string, unknown>> = [];
  const leaderProxy = BusLeader.createTelegramBusLeaderApiProxy({
    async call(method, body) {
      assert.equal(method, "sendMessage");
      directBodies.push(body);
      return { message_id: 301 };
    },
    async callMultipart() {
      throw new Error("Multipart transport is not expected");
    },
    async downloadFile() {
      throw new Error("Download transport is not expected");
    },
  });
  const busAwareApi = BusApi.createTelegramBusAwareApiRuntime({
    directRuntime: {} as TelegramBridgeApiRuntime,
    ownsDirect: () => false,
    getDefaultTarget: () => follower.target,
    async callFollowerApi(method, args) {
      assert.equal(
        Bus.isTelegramFollowerApiCallAllowed({ follower, method, args }),
        true,
      );
      return leaderProxy(method, args);
    },
  });
  const runtime = Delivery.createTelegramBridgeDeliveryRuntime({
    generation: "follower-generation",
    getTargetPolicyView: () => ({
      canDeliver: true,
      ownsDirect: false,
      allowedChatId: 77,
      followerTarget: follower.target,
    }),
    getActiveTurnTarget: () => follower.target,
    api: busAwareApi,
    recordOwnership() {},
  });

  const result = await runtime.sendView(
    { text: "Aggregate activity" },
    { scope: { kind: "aggregate" } },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(directBodies, [
    { chat_id: 77, text: "Aggregate activity" },
  ]);
});

test("Leader transport coalesces matching direct and follower chat actions", async () => {
  let calls = 0;
  let releaseAction: (value: boolean) => void = () => {};
  const pendingAction = new Promise<boolean>((resolve) => {
    releaseAction = resolve;
  });
  const directRuntime = createTelegramBridgeApiRuntime({
    client: {
      call: async <TResponse>() => {
        calls += 1;
        return (await pendingAction) as TResponse;
      },
      callMultipart: async <TResponse>() => true as TResponse,
      downloadFile: async () => "/tmp/file",
      answerCallbackQuery: async () => {},
    } satisfies TelegramApiClient,
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {},
  });
  const leaderProxy = BusLeader.createTelegramBusLeaderApiProxy({
    call: directRuntime.call,
    callMultipart: directRuntime.callMultipart,
    downloadFile: directRuntime.downloadFile,
  });
  const body = { chat_id: 77, action: "typing" };

  const direct = directRuntime.call<boolean>("sendChatAction", body);
  const follower = leaderProxy("call", ["sendChatAction", body]);
  await flushMicrotasks();
  assert.equal(calls, 1);
  releaseAction(true);
  assert.deepEqual(await Promise.all([direct, follower]), [true, true]);
});

test("Extension runtime polls, pairs, and dispatches an inbound Telegram turn into pi", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  let resolveDispatch: ((value: RuntimeHarnessMessage) => void) | undefined;
  const dispatched = new Promise<RuntimeHarnessMessage>((resolve) => {
    resolveDispatch = resolve;
  });
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      resolveDispatch?.(content);
    },
  });
  let getUpdatesCalls = 0;
  let sendMessageCalls = 0;
  const apiCalls: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    apiCalls.push(method);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 42,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "hello from telegram",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sendMessageCalls += 1;
      if (sendMessageCalls === 1) {
        return createRuntimeTelegramApiErrorResponse(
          429,
          "temporary rate limit",
        );
      }
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({ botToken: "123:abc", lastUpdateId: 0 });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    const dispatchedContent = await dispatched;
    await flushMicrotasks();
    assert.equal(sentMessages.length, 1);
    assert.equal(Array.isArray(dispatchedContent), true);
    assert.equal(apiCalls.includes("sendMessage"), true);
    assert.equal(sendMessageCalls, 2);
    assert.equal(apiCalls.includes("sendChatAction"), true);
    const promptBlock = getRuntimeHarnessTextBlock(dispatchedContent);
    assert.equal(promptBlock.type, "text");
    assert.match(promptBlock.text ?? "", /^\[telegram\] hello from telegram$/);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Durable worker keeps a poison source while draining independent journal tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-poison-tail-"));
  const path = join(dir, "inbox.json");
  const journal = Journal.createTelegramUpdateJournalStore({
    path,
    botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
      botToken: "123:poison-tail",
    }),
    getNowMs: () => 1_000,
  });
  journal.appendBatch([
    { update_id: 1, message: { text: "poison" } },
    { update_id: 2, message: { text: "valid-a" } },
    { update_id: 3, message: { text: "valid-b" } },
  ]);
  const executed: number[] = [];
  const worker = Updates.createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => true,
    getNowMs: () => 2_000,
    classifyExecutionFailure: () => ({
      disposition: "terminal",
      failureClass: "invalid-update",
      summary: "Deterministic poison update.",
    }),
    executeUpdate(update) {
      executed.push(update.update_id);
      if (update.update_id === 1) throw new Error("poison");
      return { kind: "complete" };
    },
  });
  try {
    worker.start("ctx");
    await worker.waitForDrain();
    assert.deepEqual(executed, [1, 2, 3]);
    assert.deepEqual(
      journal.read().entries.map((entry) => ({
        updateId: entry.updateId,
        state: entry.state,
        failureClass: entry.failure?.failureClass,
      })),
      [{ updateId: 1, state: "retry-wait", failureClass: "invalid-update" }],
    );
    assert.equal(worker.getState().retryWaitCount, 1);
    assert.equal(worker.getState().failedCount, 0);
    assert.equal(worker.getState().journalEntryCount, 1);
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Live replacement process cannot replay or settle another process queue receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-queue-owner-"));
  const path = join(dir, "inbox.json");
  const processBirthId = Bus.getTelegramProcessBirthIdentity(
    process.pid,
    "fixture-owner",
  );
  const queueOwnerIdentity = {
    instanceId: `owner-${process.pid}`,
    processId: process.pid,
    processBirthId,
    sessionGeneration: 1,
  };
  const journal = Journal.createTelegramUpdateJournalStore({
    path,
    botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
      botToken: "123:queue-owner-worker",
    }),
    queueRuntimeIdentity: {
      instanceId: queueOwnerIdentity.instanceId,
      processId: process.pid,
      processBirthId,
    },
  });
  journal.appendBatch([{ update_id: 1, message: { text: "once" } }]);
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "process-a-receipt",
    sourceUpdateIds: [1],
  };
  let processAHasTransport = true;
  let processAExecutions = 0;
  const processA = Updates.createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => processAHasTransport,
    getQueueOwnerIdentity: () => queueOwnerIdentity,
    executeUpdate() {
      processAExecutions += 1;
      return { kind: "queued", ...receipt };
    },
  });
  try {
    processA.start("process-a-context");
    await processA.waitForDrain();
    assert.equal(processAExecutions, 1);
    assert.equal(processA.isQueueReceiptCommitted(receipt), true);

    processAHasTransport = false;
    const replacement = await runQueueOwnerReplacementProcess(path);
    assert.deepEqual(replacement, {
      executionCount: 0,
      foreignQueuedCount: 1,
      queuedClaimCount: 0,
      entryCount: 1,
      directCompletionError: "conflict",
    });
    assert.equal(journal.read().entries.length, 1);

    processA.completeQueueReceipts({
      receipts: [receipt],
      ctx: "process-a-context",
      reason: "prompt-handoff",
    });
    await processA.waitForDrain();
    assert.equal(processAExecutions, 1);
    assert.deepEqual(journal.read().entries, []);
  } finally {
    await processA.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Transport takeover hands one live-owned prompt to one exact recipient journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-transport-handoff-"));
  const journalPath = join(dir, "inbox.json");
  const recipientJournalPath = journalPath;
  const ownersPath = join(dir, "owners.json");
  const socketPath = join(dir, "recipient.sock");
  const donorCwd = "/repo/queue-donor";
  const donorInstanceId = `donor-${process.pid}`;
  const donorProcessBirthId = Bus.getTelegramProcessBirthIdentity(
    process.pid,
    donorInstanceId,
  );
  const donorOwnerIdentity = {
    instanceId: donorInstanceId,
    processId: process.pid,
    processBirthId: donorProcessBirthId,
    sessionGeneration: 1,
  };
  const botIdentity = Journal.createTelegramUpdateJournalBotIdentity({
    botToken: "123:queue-owner-worker",
  });
  const donorJournalBindingKey = Journal.createTelegramUpdateJournalBindingKey({
    path: journalPath,
    botIdentity,
  });
  const journal = Journal.createTelegramUpdateJournalStore({
    path: journalPath,
    botIdentity,
    queueRuntimeIdentity: donorOwnerIdentity,
  });
  journal.appendBatch([{ update_id: 1, message: { text: "handoff once" } }]);
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "transport-handoff-receipt",
    sourceUpdateIds: [1],
    journalBindingKey: donorJournalBindingKey,
  };
  const target = { chatId: 7, threadId: 42 };
  const donorQueue = Queue.createTelegramQueueStore<string>();
  let donorExecutions = 0;
  let authenticatedHandoffs = 0;
  const donorWorker = Updates.createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => true,
    getJournalBindingKey: () => donorJournalBindingKey,
    getQueueOwnerIdentity: () => donorOwnerIdentity,
    executeUpdate() {
      donorExecutions += 1;
      return { kind: "queued", ...receipt };
    },
    onQueueReceiptCommitted(committedReceipt) {
      donorQueue.setQueuedItems([{
        kind: "prompt",
        chatId: target.chatId,
        target,
        transportStamp: { profile: "default", generation: "1" },
        replyToMessageId: 10,
        queueOrder: 1,
        queueLane: "default",
        laneOrder: 1,
        statusSummary: "handoff once",
        admissionReceipts: [committedReceipt],
        sourceMessageIds: [10],
        queuedAttachments: [],
        content: [{ type: "text", text: "handoff once" }],
        historyText: "handoff once",
      }]);
    },
  });
  const donorLifecycle = Updates.createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: journalPath,
      recoveryKey: donorJournalBindingKey,
      journal,
    }),
    getQueueOwnerIdentity: () => donorOwnerIdentity,
    createWorker: () => donorWorker,
  });
  const donorLock = Locks.createTelegramLockRuntime<{ cwd: string }>({
    locksPath: ownersPath,
    instanceId: donorInstanceId,
  });
  let replacement:
    | QueueOwnerTransportHandoffProcess
    | undefined;
  try {
    const acquired = donorLock.acquire({ cwd: donorCwd });
    assert.equal(acquired.ok, true);
    await donorLifecycle.onSessionStart("donor-context");
    await donorWorker.waitForDrain();
    assert.equal(donorExecutions, 1);
    assert.equal(donorQueue.getQueuedItems().length, 1);
    assert.equal(journal.read().entries[0]?.queueOwner?.processId, process.pid);

    replacement = spawnQueueOwnerTransportHandoffProcess({
      journalPath,
      recipientJournalPath,
      ownersPath,
      socketPath,
      authSecret: "handoff-secret",
      donorInstanceId,
      donorCwd,
      recipientInstanceId: "recipient-process-b",
      recipientProfileKey: "manual:recipient-process-b",
      recipientRegistrationGeneration: "recipient-generation-b",
      target,
    });
    const ready = await replacement.ready;
    assert.deepEqual(
      {
        phase: ready.phase,
        transportOwned: ready.transportOwned,
        executionCount: ready.executionCount,
        foreignQueuedCount: ready.foreignQueuedCount,
      },
      {
        phase: "ready",
        transportOwned: true,
        executionCount: 0,
        foreignQueuedCount: 1,
      },
    );
    assert.equal(donorLock.owns({ cwd: donorCwd }), false);
    assert.equal(process.pid > 0, true);

    const registry = Bus.createTelegramBusFollowerRegistry();
    registry.register({
      instanceId: "recipient-process-b",
      profileKey: "manual:recipient-process-b",
      target,
      busSocketPath: socketPath,
      registrationGeneration: "recipient-generation-b",
      protocol: Bus.createTelegramBusProtocolIdentity({
        runtimeBuild: "fixture",
        capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF],
      }),
      pid: ready.pid,
      processBirthId: ready.processBirthId,
      sessionGeneration: 1,
      connectedAtMs: Date.now(),
    });
    const reconcile = Updates.createTelegramQueueHandoffReconciler<string>({
      ownsDirect: () => false,
      isFollowerRegistered: () => true,
      isBusEnabled: () => true,
      canHandoffWithLeader: () => true,
      listFollowers: () => registry.list().filter(
        (follower) => follower.instanceId !== donorInstanceId,
      ),
      createRecipientJournalBindingKey: () => ready.recipientJournalBindingKey,
      getQueuedItems: donorQueue.getQueuedItems,
      getReceiptOwner(receipt) {
        const owner = donorLifecycle.getQueueReceiptOwner(receipt);
        assert.ok(owner, `missing donor owner for ${JSON.stringify(receipt)}`);
        return owner;
      },
      getLifecycleForReceipt(receipt) {
        assert.equal(receipt.journalBindingKey, donorJournalBindingKey);
        return donorLifecycle;
      },
      createHandoffToken: Journal.createTelegramUpdateQueueHandoffToken,
      createRequestId: () => "transport-handoff:1",
      donorInstanceId,
      async stageThroughFollower(input) {
        const response = await Bus.sendTelegramBusLocalEnvelope({
          socketPath,
          timeoutMs: 1_000,
          envelope: {
            kind: "leader.offerQueueHandoff",
            requestId: "transport-handoff:1",
            auth: "handoff-secret",
            recipientInstanceId: input.recipient.instanceId,
            recipientRegistrationGeneration:
              input.recipient.registrationGeneration!,
            donorInstanceId,
            donorProcessId: input.expectedOwner.processId,
            donorProcessBirthId: input.expectedOwner.processBirthId,
            donorSessionGeneration: input.expectedOwner.sessionGeneration,
            donorAcquisitionId: input.expectedOwner.acquisitionId,
            donorAcquiredAtMs: input.expectedOwner.acquiredAtMs,
            handoffToken: input.handoffToken,
            payload: input.payload,
            sentAtMs: Date.now(),
          },
        });
        if (
          response?.kind !== "bus.ack" ||
          !response.ok ||
          !response.result ||
          typeof response.result !== "object"
        ) {
          throw new Error(
            response?.kind === "bus.ack"
              ? response.message ?? "handoff rejected"
              : "missing handoff response",
          );
        }
        authenticatedHandoffs += 1;
        return response.result as Queue.TelegramQueueHandoffStageResult;
      },
      async routeThroughLeader(input) {
        const response = await Bus.sendTelegramBusLocalEnvelope({
          socketPath,
          timeoutMs: 1_000,
          envelope: {
            kind: "leader.offerQueueHandoff",
            requestId: input.requestId,
            auth: input.auth,
            recipientInstanceId: input.recipientInstanceId,
            recipientRegistrationGeneration:
              input.recipientRegistrationGeneration,
            donorInstanceId: input.donorInstanceId,
            donorProcessId: input.donorProcessId,
            donorProcessBirthId: input.donorProcessBirthId,
            donorSessionGeneration: input.donorSessionGeneration,
            donorAcquisitionId: input.donorAcquisitionId,
            donorAcquiredAtMs: input.donorAcquiredAtMs,
            handoffToken: input.handoffToken,
            payload: input.payload,
            sentAtMs: input.sentAtMs,
          },
        });
        if (response?.kind === "bus.ack" && response.ok) {
          authenticatedHandoffs += 1;
        }
        return response ?? {
          kind: "bus.ack",
          requestId: input.requestId,
          ok: false,
          message: "missing handoff response",
        };
      },
      removeDonorItem(exactReceipt) {
        return Queue.removeTelegramQueueItemByReceipt({
          receipt: exactReceipt,
          store: donorQueue,
        });
      },
      recordFailure(error) {
        throw error;
      },
    });
    await reconcile("donor-context");

    assert.equal(registry.list().length, 1);
    assert.deepEqual(registry.list()[0]?.target, target);
    assert.equal(donorQueue.getQueuedItems().length, 0);
    assert.equal(authenticatedHandoffs, 1);
    assert.equal(donorExecutions, 1);
    assert.deepEqual(donorQueue.getQueuedItems(), []);
    assert.equal(journal.read().entries[0]?.queueOwner?.processId, ready.pid);
    assert.equal(journal.read().entries[0]?.queueHandoff, undefined);
    const recipientFile = JSON.parse(
      await readFile(recipientJournalPath, "utf8"),
    ) as { entries: unknown[] };
    assert.equal(recipientFile.entries.length, 1);

    const stopped = await replacement.stop();
    replacement = undefined;
    assert.deepEqual(stopped, {
      phase: "stopped",
      executionCount: 0,
      foreignQueuedCount: 1,
      donorEntryCount: 1,
      recipientEntryCount: 1,
      recipientQueueCount: 1,
      handoffCount: 1,
      controlExecutions: [],
      droppedHandoffAck: false,
    });
  } finally {
    if (replacement) {
      replacement.child.kill("SIGKILL");
      await new Promise((resolve) => replacement?.child.once("close", resolve));
    }
    await donorLifecycle.onSessionShutdown();
    donorLock.release();
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("Queued control handoff reconstructs one local execution in the recipient process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-control-handoff-"));
  const journalPath = join(dir, "inbox.json");
  const ownersPath = join(dir, "owners.json");
  const socketPath = join(dir, "recipient.sock");
  const donorCwd = "/repo/control-donor";
  const donorInstanceId = `control-donor-${process.pid}`;
  const donorProcessBirthId = Bus.getTelegramProcessBirthIdentity(
    process.pid,
    donorInstanceId,
  );
  const donorOwnerIdentity = {
    instanceId: donorInstanceId,
    processId: process.pid,
    processBirthId: donorProcessBirthId,
    sessionGeneration: 1,
  };
  const botIdentity = Journal.createTelegramUpdateJournalBotIdentity({
    botToken: "123:queue-owner-worker",
  });
  const donorJournalBindingKey = Journal.createTelegramUpdateJournalBindingKey({
    path: journalPath,
    botIdentity,
  });
  const journal = Journal.createTelegramUpdateJournalStore({
    path: journalPath,
    botIdentity,
    queueRuntimeIdentity: donorOwnerIdentity,
  });
  journal.appendBatch([{ update_id: 1, callback_query: { id: "control" } }]);
  const receipt = {
    queueKind: "control" as const,
    receiptId: "control-handoff-receipt",
    sourceUpdateIds: [1],
    journalBindingKey: donorJournalBindingKey,
  };
  const target = { chatId: 7, threadId: 44 };
  const donorQueue = Queue.createTelegramQueueStore<string>();
  let donorControlExecutions = 0;
  const donorWorker = Updates.createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => true,
    getJournalBindingKey: () => donorJournalBindingKey,
    getQueueOwnerIdentity: () => donorOwnerIdentity,
    executeUpdate: () => ({ kind: "queued", ...receipt }),
    onQueueReceiptCommitted(committedReceipt) {
      donorQueue.setQueuedItems([{
        kind: "control",
        controlType: "status",
        chatId: target.chatId,
        target,
        transportStamp: { profile: "default", generation: "1" },
        replyToMessageId: 12,
        queueOrder: 1,
        queueLane: "control",
        laneOrder: 1,
        statusSummary: "status",
        admissionReceipts: [committedReceipt],
        execute: async () => {
          donorControlExecutions += 1;
        },
      }]);
    },
  });
  const donorLifecycle = Updates.createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: journalPath,
      recoveryKey: donorJournalBindingKey,
      journal,
    }),
    getQueueOwnerIdentity: () => donorOwnerIdentity,
    createWorker: () => donorWorker,
  });
  const donorLock = Locks.createTelegramLockRuntime<{ cwd: string }>({
    locksPath: ownersPath,
    instanceId: donorInstanceId,
  });
  let replacement: QueueOwnerTransportHandoffProcess | undefined;
  try {
    assert.equal(donorLock.acquire({ cwd: donorCwd }).ok, true);
    await donorLifecycle.onSessionStart("donor-context");
    await donorWorker.waitForDrain();
    replacement = spawnQueueOwnerTransportHandoffProcess({
      journalPath,
      recipientJournalPath: journalPath,
      ownersPath,
      socketPath,
      authSecret: "handoff-secret",
      donorInstanceId,
      donorCwd,
      recipientInstanceId: "recipient-control",
      recipientProfileKey: "manual:recipient-control",
      recipientRegistrationGeneration: "recipient-generation-control",
      target,
    });
    const ready = await replacement.ready;
    const expectedOwner = donorLifecycle.getQueueReceiptOwner(receipt);
    assert.ok(expectedOwner);
    const item = donorQueue.getQueuedItems()[0];
    assert.ok(item);
    const result = await Updates.coordinateTelegramQueueHandoff({
      item,
      expectedOwner,
      recipientOwner: {
        instanceId: "recipient-control",
        processId: ready.pid,
        processBirthId: ready.processBirthId,
        sessionGeneration: 1,
      },
      handoffToken: Journal.createTelegramUpdateQueueHandoffToken(),
      lifecycle: donorLifecycle,
      async stageRemote(input) {
        const response = await Bus.sendTelegramBusLocalEnvelope({
          socketPath,
          timeoutMs: 1_000,
          envelope: {
            kind: "leader.offerQueueHandoff",
            requestId: "control-handoff:1",
            auth: "handoff-secret",
            recipientInstanceId: "recipient-control",
            recipientRegistrationGeneration: "recipient-generation-control",
            donorInstanceId,
            donorProcessId: input.expectedOwner.processId,
            donorProcessBirthId: input.expectedOwner.processBirthId,
            donorSessionGeneration: input.expectedOwner.sessionGeneration,
            donorAcquisitionId: input.expectedOwner.acquisitionId,
            donorAcquiredAtMs: input.expectedOwner.acquiredAtMs,
            handoffToken: input.handoffToken,
            payload: {
              ...input.payload,
              admissionReceipts: [{
                ...input.payload.admissionReceipts[0]!,
                journalBindingKey: ready.recipientJournalBindingKey,
              }],
            },
            sentAtMs: Date.now(),
          },
        });
        if (
          response?.kind !== "bus.ack" ||
          !response.ok ||
          !response.result ||
          typeof response.result !== "object"
        ) {
          throw new Error("control handoff was rejected");
        }
        return response.result as Queue.TelegramQueueHandoffStageResult;
      },
      removeDonorItem: () =>
        Queue.removeTelegramQueueItemByReceipt({ receipt, store: donorQueue }),
    });
    assert.equal(result.status, "transferred");
    assert.equal(donorControlExecutions, 0);
    assert.deepEqual(donorQueue.getQueuedItems(), []);
    assert.equal(journal.read().entries[0]?.queueOwner?.processId, ready.pid);

    const stopped = await replacement.stop("execute-control");
    replacement = undefined;
    assert.deepEqual(stopped, {
      phase: "stopped",
      executionCount: 0,
      foreignQueuedCount: 1,
      donorEntryCount: 1,
      recipientEntryCount: 1,
      recipientQueueCount: 1,
      handoffCount: 1,
      controlExecutions: ["status"],
      droppedHandoffAck: false,
    });
  } finally {
    if (replacement) {
      replacement.child.kill("SIGKILL");
      await new Promise((resolve) => replacement?.child.once("close", resolve));
    }
    await donorLifecycle.onSessionShutdown();
    donorLock.release();
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("Lost handoff ACK cannot cancel accepted cross-process authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-handoff-ack-loss-"));
  const journalPath = join(dir, "inbox.json");
  const ownersPath = join(dir, "owners.json");
  const socketPath = join(dir, "recipient.sock");
  const donorCwd = "/repo/ack-loss-donor";
  const donorInstanceId = `ack-loss-donor-${process.pid}`;
  const donorProcessBirthId = Bus.getTelegramProcessBirthIdentity(
    process.pid,
    donorInstanceId,
  );
  const donorOwnerIdentity = {
    instanceId: donorInstanceId,
    processId: process.pid,
    processBirthId: donorProcessBirthId,
    sessionGeneration: 1,
  };
  const botIdentity = Journal.createTelegramUpdateJournalBotIdentity({
    botToken: "123:queue-owner-worker",
  });
  const donorJournalBindingKey = Journal.createTelegramUpdateJournalBindingKey({
    path: journalPath,
    botIdentity,
  });
  const journal = Journal.createTelegramUpdateJournalStore({
    path: journalPath,
    botIdentity,
    queueRuntimeIdentity: donorOwnerIdentity,
  });
  journal.appendBatch([{ update_id: 1, message: { text: "ack lost" } }]);
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "ack-loss-receipt",
    sourceUpdateIds: [1],
    journalBindingKey: donorJournalBindingKey,
  };
  const target = { chatId: 7, threadId: 43 };
  const donorQueue = Queue.createTelegramQueueStore<string>();
  const donorWorker = Updates.createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => true,
    getJournalBindingKey: () => donorJournalBindingKey,
    getQueueOwnerIdentity: () => donorOwnerIdentity,
    executeUpdate: () => ({ kind: "queued", ...receipt }),
    onQueueReceiptCommitted(committedReceipt) {
      donorQueue.setQueuedItems([{
        kind: "prompt",
        chatId: target.chatId,
        target,
        transportStamp: { profile: "default", generation: "1" },
        replyToMessageId: 11,
        queueOrder: 1,
        queueLane: "default",
        laneOrder: 1,
        statusSummary: "ack lost",
        admissionReceipts: [committedReceipt],
        sourceMessageIds: [11],
        queuedAttachments: [],
        content: [{ type: "text", text: "ack lost" }],
        historyText: "ack lost",
      }]);
    },
  });
  const donorLifecycle = Updates.createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: journalPath,
      recoveryKey: donorJournalBindingKey,
      journal,
    }),
    getQueueOwnerIdentity: () => donorOwnerIdentity,
    createWorker: () => donorWorker,
  });
  const donorLock = Locks.createTelegramLockRuntime<{ cwd: string }>({
    locksPath: ownersPath,
    instanceId: donorInstanceId,
  });
  let replacement: QueueOwnerTransportHandoffProcess | undefined;
  try {
    assert.equal(donorLock.acquire({ cwd: donorCwd }).ok, true);
    await donorLifecycle.onSessionStart("donor-context");
    await donorWorker.waitForDrain();
    replacement = spawnQueueOwnerTransportHandoffProcess({
      journalPath,
      recipientJournalPath: journalPath,
      ownersPath,
      socketPath,
      authSecret: "handoff-secret",
      donorInstanceId,
      donorCwd,
      recipientInstanceId: "recipient-ack-loss",
      recipientProfileKey: "manual:recipient-ack-loss",
      recipientRegistrationGeneration: "recipient-generation-ack-loss",
      target,
      dropHandoffAck: true,
    });
    const ready = await replacement.ready;
    const lifecycle = donorLifecycle;
    const expectedOwner = lifecycle.getQueueReceiptOwner(receipt);
    assert.ok(expectedOwner);
    const item = donorQueue.getQueuedItems()[0];
    assert.ok(item);
    let cancellationAttempts = 0;
    const result = await Updates.coordinateTelegramQueueHandoff({
      item,
      expectedOwner,
      recipientOwner: {
        instanceId: "recipient-ack-loss",
        processId: ready.pid,
        processBirthId: ready.processBirthId,
        sessionGeneration: 1,
      },
      handoffToken: Journal.createTelegramUpdateQueueHandoffToken(),
      lifecycle: {
        offerQueueReceiptHandoff: lifecycle.offerQueueReceiptHandoff,
        acceptQueueReceiptHandoff: lifecycle.acceptQueueReceiptHandoff,
        cancelQueueReceiptHandoff(input) {
          cancellationAttempts += 1;
          return lifecycle.cancelQueueReceiptHandoff(input);
        },
      },
      async stageRemote(input) {
        const response = await Bus.sendTelegramBusLocalEnvelope({
          socketPath,
          timeoutMs: 5_000,
          envelope: {
            kind: "leader.offerQueueHandoff",
            requestId: "ack-loss:1",
            auth: "handoff-secret",
            recipientInstanceId: "recipient-ack-loss",
            recipientRegistrationGeneration: "recipient-generation-ack-loss",
            donorInstanceId,
            donorProcessId: input.expectedOwner.processId,
            donorProcessBirthId: input.expectedOwner.processBirthId,
            donorSessionGeneration: input.expectedOwner.sessionGeneration,
            donorAcquisitionId: input.expectedOwner.acquisitionId,
            donorAcquiredAtMs: input.expectedOwner.acquiredAtMs,
            handoffToken: input.handoffToken,
            payload: {
              ...input.payload,
              admissionReceipts: [{
                ...input.payload.admissionReceipts[0]!,
                journalBindingKey: ready.recipientJournalBindingKey,
              }],
            },
            sentAtMs: Date.now(),
          },
        });
        throw new Error(`unexpected handoff response: ${JSON.stringify(response)}`);
      },
      removeDonorItem: () =>
        Queue.removeTelegramQueueItemByReceipt({ receipt, store: donorQueue }),
    });
    assert.equal(result.status, "retained");
    if (result.status !== "retained") assert.fail("expected retained result");
    assert.equal(result.cancelled, false);
    assert.equal(cancellationAttempts, 1);
    assert.equal(donorQueue.getQueuedItems().length, 1);
    assert.equal(journal.read().entries[0]?.queueOwner?.processId, ready.pid);
    assert.equal(journal.read().entries[0]?.queueHandoff, undefined);

    const stopped = await replacement.stop();
    replacement = undefined;
    assert.deepEqual(stopped, {
      phase: "stopped",
      executionCount: 0,
      foreignQueuedCount: 1,
      donorEntryCount: 1,
      recipientEntryCount: 1,
      recipientQueueCount: 1,
      handoffCount: 1,
      controlExecutions: [],
      droppedHandoffAck: true,
    });
  } finally {
    if (replacement) {
      replacement.child.kill("SIGKILL");
      await new Promise((resolve) => replacement?.child.once("close", resolve));
    }
    await donorLifecycle.onSessionShutdown();
    donorLock.release();
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("Live owner remains fenced when replacement races dead-owner recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-live-owner-race-"));
  const path = join(dir, "inbox.json");
  const processBirthId = Bus.getTelegramProcessBirthIdentity(
    process.pid,
    "fixture-live-owner",
  );
  const ownerIdentity = {
    instanceId: `live-owner-${process.pid}`,
    processId: process.pid,
    processBirthId,
    sessionGeneration: 1,
  };
  const ownerJournal = Journal.createTelegramUpdateJournalStore({
    path,
    botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
      botToken: "123:queue-owner-worker",
    }),
    queueRuntimeIdentity: {
      instanceId: ownerIdentity.instanceId,
      processId: process.pid,
      processBirthId,
    },
  });
  ownerJournal.appendBatch([
    { update_id: 1, message: { text: "live owner" } },
  ]);
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "process-a-receipt",
    sourceUpdateIds: [1],
  };
  const ownerWorker = Updates.createTelegramUpdateWorkerRuntime({
    journal: ownerJournal,
    hasAuthority: () => true,
    getQueueOwnerIdentity: () => ownerIdentity,
    executeUpdate: () => ({ kind: "queued", ...receipt }),
  });
  try {
    ownerWorker.start("live-owner-context");
    await ownerWorker.waitForDrain();
    const replacement = await runQueueOwnerReplacementProcess(
      path,
      "recover",
    );
    assert.deepEqual(replacement, {
      executionCount: 0,
      foreignQueuedCount: 1,
      queuedClaimCount: 0,
      entryCount: 1,
      directCompletionError: "conflict",
      recoveryStatus:
        process.platform === "win32" ? "owner-unverifiable" : "owner-alive",
    });
    assert.equal(ownerWorker.isQueueReceiptCommitted(receipt), true);
    ownerWorker.completeQueueReceipts({
      receipts: [receipt],
      ctx: "live-owner-context",
      reason: "prompt-handoff",
    });
    await ownerWorker.waitForDrain();
    assert.deepEqual(ownerJournal.read().entries, []);
  } finally {
    await ownerWorker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Live Windows queue owner remains unrecoverable and unreplayable without a birth proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-windows-owner-"));
  const path = join(dir, "inbox.json");
  const foreignOwner = {
    instanceId: "windows-owner",
    processId: 4242,
    processBirthId: "4242:generation:windows-owner",
    sessionGeneration: 1,
    acquisitionId: "windows-acquisition",
    acquiredAtMs: 1,
  };
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      profile: "default",
      botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
        botToken: "123:queue-owner-worker",
      }),
      entries: [
        {
          updateId: 1,
          update: { update_id: 1, message: { text: "windows owner" } },
          admittedAtMs: 1,
          state: "queued",
          queueKind: "prompt",
          queueReceiptId: "windows-owner-receipt",
          queueOwner: foreignOwner,
        },
      ],
    }),
    "utf8",
  );
  const replacementIdentity = {
    instanceId: "windows-replacement",
    processId: 5252,
    processBirthId: "5252:generation:windows-replacement",
    sessionGeneration: 1,
  };
  const journal = Journal.createTelegramUpdateJournalStore({
    path,
    botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
      botToken: "123:queue-owner-worker",
    }),
    queueRuntimeIdentity: replacementIdentity,
    getQueueProcessLiveness: (owner) =>
      Bus.getTelegramProcessLiveness(owner, {
        platform: "win32",
        isProcessAlive: () => true,
      }),
  });
  let executionCount = 0;
  const worker = Updates.createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => true,
    getQueueOwnerIdentity: () => replacementIdentity,
    executeUpdate() {
      executionCount += 1;
      return { kind: "complete" };
    },
  });
  try {
    worker.start("windows-replacement-context");
    await worker.waitForDrain();
    assert.equal(executionCount, 0);
    assert.equal(worker.getState().foreignQueuedCount, 1);
    const result = journal.recoverDeadQueueOwner({
      queueKind: "prompt",
      receiptId: "windows-owner-receipt",
      sourceUpdateIds: [1],
      deadOwner: foreignOwner,
      recoveryOwner: replacementIdentity,
    });
    assert.equal(result.status, "owner-unverifiable");
    worker.signal();
    await worker.waitForDrain();
    assert.equal(executionCount, 0);
    assert.deepEqual(journal.read().entries[0]?.queueOwner, foreignOwner);
    assert.throws(
      () =>
        journal.completeQueued([
          {
            queueKind: "prompt",
            receiptId: "windows-owner-receipt",
            sourceUpdateIds: [1],
            queueOwner: foreignOwner,
          },
        ]),
      (error) =>
        error instanceof Journal.TelegramUpdateJournalError &&
        error.code === "conflict",
    );
  } finally {
    await worker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Replacement registration stays live while its process races dead-owner recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-registration-recovery-race-"));
  const journalPath = join(dir, "inbox.json");
  const socketPath = join(dir, "leader.sock");
  const startPath = join(dir, "start");
  const instanceId = "replacement-race";
  const botIdentity = Journal.createTelegramUpdateJournalBotIdentity({
    botToken: "123:queue-owner-worker",
  });
  await writeFile(
    journalPath,
    JSON.stringify({
      version: 1,
      profile: "default",
      botIdentity,
      entries: [{
        updateId: 1,
        update: { update_id: 1, message: { text: "race" } },
        admittedAtMs: 1,
        state: "queued",
        queueKind: "prompt",
        queueReceiptId: "registration-race-receipt",
        queueOwner: {
          instanceId,
          processId: 2_000_000_000,
          processBirthId: "2000000000:start:dead",
          sessionGeneration: 1,
          acquisitionId: "stale-acquisition",
          acquiredAtMs: 1,
        },
      }],
    }),
    "utf8",
  );
  try {
    const result = await runRegistrationRecoveryRaceProcess({
      journalPath,
      socketPath,
      startPath,
      instanceId,
      profileKey: "manual:replacement-race",
      registrationGeneration: "replacement-race:generation-1",
      target: { chatId: 7, threadId: 45 },
    });
    assert.deepEqual(result, {
      phase: "result",
      registrationOk: true,
      recoveryStatus: "owner-alive",
      registeredPid: result.registeredPid,
      registeredProcessBirthId: result.registeredProcessBirthId,
      ownerAlive: true,
      journalState: "queued",
      journalOwnerPid: result.registeredPid,
    });
    assert.equal(result.registeredPid > 0, true);
    assert.notEqual(result.registeredProcessBirthId, "2000000000:start:dead");
    const journal = Journal.createTelegramUpdateJournalStore({
      path: journalPath,
      botIdentity,
    });
    assert.equal(journal.read().entries[0]?.state, "queued");
    assert.equal(
      journal.read().entries[0]?.queueOwner?.acquisitionId,
      "stale-acquisition",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("Replacement process discards dead session-owned queue authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-dead-owner-"));
  const path = join(dir, "inbox.json");
  const deadOwner = {
    instanceId: "dead-owner-instance",
    processId: 2_000_000_000,
    processBirthId: "2000000000:start:dead",
    sessionGeneration: 1,
    acquisitionId: "dead-acquisition",
    acquiredAtMs: 1,
  };
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      profile: "default",
      botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
        botToken: "123:queue-owner-worker",
      }),
      entries: [
        {
          updateId: 1,
          update: { update_id: 1, message: { text: "recover once" } },
          admittedAtMs: 1,
          state: "queued",
          queueKind: "prompt",
          queueReceiptId: "process-a-receipt",
          queueOwner: deadOwner,
        },
      ],
    }),
    "utf8",
  );
  try {
    const replacement = await runQueueOwnerReplacementProcess(
      path,
      "recover",
    );
    assert.deepEqual(replacement, {
      executionCount: 0,
      foreignQueuedCount: 0,
      queuedClaimCount: 0,
      entryCount: 0,
      directCompletionError: "conflict",
      recoveryStatus: "recovered",
    });
    const journal = Journal.createTelegramUpdateJournalStore({
      path,
      botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
        botToken: "123:queue-owner-worker",
      }),
    });
    assert.deepEqual(journal.read().entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Extension startup preserves queued authority owned by another process", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const agentDir = await ensureRuntimeAgentDir();
  const journalPath = join(agentDir, "tmp", "telegram", "inbox.json");
  const journal = Journal.createTelegramUpdateJournalStore({
    path: journalPath,
    botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
      botToken: "123:recovery",
    }),
  });
  const dispatched: RuntimeHarnessMessage[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => dispatched.push(content),
  });
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook" || method === "setMyCommands") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getMe") {
      return createRuntimeTelegramApiResponse({
        id: 123,
        username: "recovery_bot",
        has_topics_enabled: false,
      });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:recovery",
      allowedUserId: 77,
      lastUpdateId: 502,
    });
    journal.appendBatch([
      {
        update_id: 501,
        message: {
          message_id: 501,
          chat: { id: 77, type: "private" },
          from: { id: 77, is_bot: false, first_name: "Owner" },
          text: "owned comment",
        },
      },
      {
        update_id: 502,
        message: {
          message_id: 502,
          chat: { id: 77, type: "private" },
          from: { id: 77, is_bot: false, first_name: "Owner" },
          text: "owned follow-up",
        },
      },
    ]);
    const queued = journal.markQueued({
      queueKind: "prompt",
      receiptId: "foreign-process-receipt",
      sourceUpdateIds: [501, 502],
      owner: {
        instanceId: "foreign-instance",
        processId: process.pid,
        processBirthId: Bus.getTelegramProcessBirthIdentity(
          process.pid,
          "foreign-live-owner",
        ),
        sessionGeneration: 4,
      },
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({ cwd: "/repo/journal-recovery" });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await flushMicrotasks();
    await waitForTimeout(20);

    assert.deepEqual(dispatched, []);
    const snapshot = journal.read();
    assert.deepEqual(
      snapshot.entries.map((entry) => ({
        updateId: entry.updateId,
        state: entry.state,
        queueReceiptId: entry.queueReceiptId,
        queueOwner: entry.queueOwner,
      })),
      [
        {
          updateId: 501,
          state: "queued",
          queueReceiptId: "foreign-process-receipt",
          queueOwner: queued.queueOwner,
        },
        {
          updateId: 502,
          state: "queued",
          queueReceiptId: "foreign-process-receipt",
          queueOwner: queued.queueOwner,
        },
      ],
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await rm(journalPath, { force: true });
    await writeRuntimeTelegramLocks({});
    await telegramConfig.restore();
  }
});

test("Extension runtime coalesces a cross-batch forward comment into one Pi turn", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  let resolveDispatch!: (value: RuntimeHarnessMessage) => void;
  const dispatched = new Promise<RuntimeHarnessMessage>((resolve) => {
    resolveDispatch = resolve;
  });
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      resolveDispatch(content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            update_id: 10,
            message: {
              message_id: 50,
              chat: { id: 77, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Owner" },
              text: "Мой комментарий",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) {
        return createRuntimeTelegramApiResponse([
          {
            update_id: 11,
            message: {
              message_id: 51,
              chat: { id: 77, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Owner" },
              forward_origin: {
                type: "user",
                sender_user: {
                  id: 88,
                  is_bot: false,
                  first_name: "Source",
                  username: "source",
                },
              },
              text: "Пересланный текст",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    const dispatchedContent = await dispatched;
    assert.equal(sentMessages.length, 1);
    const promptBlock = getRuntimeHarnessTextBlock(dispatchedContent);
    assert.equal(
      promptBlock.text,
      "[telegram] Мой комментарий\n\n[forward|from:source] Пересланный текст",
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime finalizes queued turn after polling ownership moves away", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const extension = await getRuntimeTelegramExtension();
  let resolveDispatch: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });
  const draftTexts: string[] = [];
  const sentTexts: string[] = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const editedTexts: string[] = [];
  let releasePolling: (() => void) | undefined;
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: () => {
      resolveDispatch?.();
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 7,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "please answer",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) {
        return new Promise<Response>((resolve) => {
          releasePolling = () => resolve(createRuntimeTelegramApiResponse([]));
        });
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessageDraft") {
      draftTexts.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendRichMessageDraft") {
      const richMessage = body?.rich_message as
        | { markdown?: string }
        | undefined;
      draftTexts.push(String(richMessage?.markdown ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendRichMessage") {
      const richMessage = body?.rich_message as
        | { markdown?: string }
        | undefined;
      sentTexts.push(String(richMessage?.markdown ?? ""));
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sentTexts.length,
      });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentTexts.push(String(body?.text ?? ""));
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sentTexts.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "editMessageText") {
      editedTexts.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    extension(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await dispatched;
    await handlers.get("agent_start")?.({}, ctx);
    await writeRuntimeTelegramLocks({
      default: {
        pid: process.pid + 1_000_000,
        cwd: "/tmp/other-pi-instance",
      },
    });
    mock.timers.tick(1100);
    await flushMicrotasks(20);
    await handlers.get("message_update")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Draft **preview**" }],
        },
      },
      ctx,
    );
    mock.timers.tick(1000);
    await flushMicrotasks(50);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Final **answer**" }],
          },
        ],
      },
      ctx,
    );
    mock.timers.tick(0);
    await flushMicrotasks(20);
    await waitForTimeout(20);
    assert.deepEqual(draftTexts, []);
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0] ?? "", /Final \*\*answer\*\*/);
    assert.deepEqual(sentBodies[0]?.reply_parameters, {
      message_id: 7,
      allow_sending_without_reply: true,
    });
    assert.deepEqual(editedTexts, []);
    releasePolling?.();
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    mock.timers.reset();
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime keeps local queue progress but fences delivery after ownership moves away", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 7,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first accepted",
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 8,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "second queued",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendRichMessage") {
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/queue-owner-a",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() => sentMessages.length === 1);
    assert.match(
      getRuntimeHarnessMessageText(sentMessages[0] as RuntimeHarnessMessage),
      /^\[telegram\] first accepted$/,
    );
    const journalPath = join(
      await ensureRuntimeAgentDir(),
      "tmp",
      "telegram",
      "inbox.json",
    );
    const runtimeJournal = Journal.createTelegramUpdateJournalStore({
      path: journalPath,
      botIdentity: Journal.createTelegramUpdateJournalBotIdentity({
        botToken: "123:abc",
      }),
    });
    await waitForAsyncCondition(async () =>
      runtimeJournal
        .read()
        .entries.some(
          (entry) => entry.updateId === 2 && entry.state === "queued",
        ),
    );
    await handlers.get("agent_start")?.({}, ctx);
    await writeRuntimeTelegramLocks({
      default: {
        pid: process.pid + 1_000_000,
        cwd: "/repo/queue-owner-b",
      },
    });
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "First **final**" }],
          },
        ],
      },
      ctx,
    );
    // Follow-up dispatch is intentionally routed through the session-bound
    // deferred queue timer; wait on real time instead of setImmediate turns.
    await waitForCondition(() => sentMessages.length === 2);
    assert.deepEqual(sentBodies, []);
    assert.match(
      getRuntimeHarnessMessageText(sentMessages[1] as RuntimeHarnessMessage),
      /^\[telegram\] second queued$/,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime ignores the retired proactive opt-out while Telegram is connected", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi, getActiveTools } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      assistant: { proactivePush: false },
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-disabled-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    assert.deepEqual(getActiveTools(), ["read", "foreign_tool"]);
    await commands.get("telegram-connect")?.handler("", ctx);
    assert.deepEqual(getActiveTools(), [
      "read",
      "foreign_tool",
      "telegram_attach",
      "telegram_bind",
      "telegram_message",
    ]);
    await flushMicrotasks(20);
    await handlers.get("input")?.(
      { source: "interactive", text: "local request" },
      ctx,
    );
    await handlers.get("agent_start")?.({}, ctx);
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Local **done**" }],
    };
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Local **done**",
          partial: assistantMessage,
        },
      },
      ctx,
    );
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "done",
          reason: "stop",
          message: assistantMessage,
        },
      },
      ctx,
    );
    await waitForCondition(() => sentBodies.length === 1);
    assert.equal(sentBodies[0]?.chat_id, 77);
    assert.match(
      String(
        (sentBodies[0]?.rich_message as { markdown?: string } | undefined)
          ?.markdown ?? "",
      ),
      /Local \*\*done\*\*/,
    );
    await handlers.get("agent_end")?.(
      { type: "agent_end", messages: [assistantMessage] },
      ctx,
    );
    await commands.get("telegram-disconnect")?.handler("", ctx);
    assert.deepEqual(getActiveTools(), ["read", "foreign_tool"]);
    assert.deepEqual(
      await handlers.get("before_agent_start")?.(
        { prompt: "local after disconnect", systemPrompt: "base" },
        ctx,
      ),
      { systemPrompt: "base" },
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime resolves stale same-cwd lock before proactive local result", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  let getUpdatesCalls = 0;
  const { handlers, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    const cwd = "/repo/proactive-stale-owner";
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      assistant: { proactivePush: true },
    });
    await writeRuntimeTelegramLocks({
      default: {
        pid: process.pid + 1_000_000,
        cwd,
      },
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({ cwd });
    await handlers.get("session_start")?.({}, ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 1, 5000);
    await handlers.get("input")?.(
      { source: "extension", text: "autonomous continuation" },
      ctx,
    );
    await handlers.get("agent_start")?.({}, ctx);
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Local **done**" }],
    };
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Local **done**",
          partial: assistantMessage,
        },
      },
      ctx,
    );
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "done",
          reason: "stop",
          message: assistantMessage,
        },
      },
      ctx,
    );
    await flushMicrotasks(20);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0]?.chat_id, 77);
    assert.match(
      String(
        (sentBodies[0]?.rich_message as { markdown?: string } | undefined)
          ?.markdown ?? "",
      ),
      /Local \*\*done\*\*/,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime sends proactive checkpoints and final once in source order", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      assistant: { proactivePush: true },
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await flushMicrotasks(20);
    await handlers.get("input")?.(
      { source: "interactive", text: "local request" },
      ctx,
    );
    await handlers.get("agent_start")?.({}, ctx);
    const checkpointMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Checkpoint **one**" }],
    };
    await handlers.get("message_update")?.(
      {
        message: checkpointMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Checkpoint **one**",
          partial: checkpointMessage,
        },
      },
      ctx,
    );
    await handlers.get("message_update")?.(
      {
        message: checkpointMessage,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          partial: checkpointMessage,
        },
      },
      ctx,
    );
    const reasoningMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }],
    };
    await handlers.get("message_update")?.(
      {
        message: reasoningMessage,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "private reasoning",
          partial: reasoningMessage,
        },
      },
      ctx,
    );
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Local **done**" }],
    };
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Local **done**",
          partial: assistantMessage,
        },
      },
      ctx,
    );
    await handlers.get("message_update")?.(
      {
        message: assistantMessage,
        assistantMessageEvent: {
          type: "done",
          reason: "stop",
          message: assistantMessage,
        },
      },
      ctx,
    );
    await flushMicrotasks(20);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(sentBodies.length, 2);
    assert.deepEqual(
      sentBodies.map((body) => body.chat_id),
      [77, 77],
    );
    const sentMarkdown = sentBodies.map(
      (body) =>
        (body.rich_message as { markdown?: string } | undefined)?.markdown ?? "",
    );
    assert.match(sentMarkdown[0] ?? "", /Checkpoint \*\*one\*\*/);
    assert.match(sentMarkdown[1] ?? "", /Local \*\*done\*\*/);
    assert.equal(
      sentMarkdown.some((text) => text.includes("private reasoning")),
      false,
    );
    await commands.get("telegram-disconnect")?.handler("", ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime drops queued proactive blocks after session replacement", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  let sendCalls = 0;
  let getUpdatesCalls = 0;
  let markFirstSendStarted!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => {
    markFirstSendStarted = resolve;
  });
  let releaseFirstSend!: () => void;
  const firstSendGate = new Promise<void>((resolve) => {
    releaseFirstSend = resolve;
  });
  const { handlers, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendRichMessage") {
      sendCalls += 1;
      if (sendCalls === 1) {
        markFirstSendStarted();
        await firstSendGate;
      }
      return createRuntimeTelegramApiResponse({ message_id: 100 + sendCalls });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    const cwd = "/repo/proactive-replacement";
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      assistant: { proactivePush: true },
    });
    await writeRuntimeTelegramLocks({
      default: { pid: process.pid + 1_000_000, cwd },
    });
    (await getRuntimeTelegramExtension())(pi);
    const oldCtx = createRuntimeExtensionContext({ cwd });
    await handlers.get("session_start")?.({}, oldCtx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 1, 5000);
    await handlers.get("input")?.(
      { source: "extension", text: "replacement probe" },
      oldCtx,
    );
    await handlers.get("agent_start")?.({}, oldCtx);
    const checkpointMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Old checkpoint" }],
    };
    await handlers.get("message_update")?.(
      {
        message: checkpointMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Old checkpoint",
          partial: checkpointMessage,
        },
      },
      oldCtx,
    );
    await handlers.get("message_update")?.(
      {
        message: checkpointMessage,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          partial: checkpointMessage,
        },
      },
      oldCtx,
    );
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Old queued final" }],
    };
    await handlers.get("message_update")?.(
      {
        message: finalMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Old queued final",
          partial: finalMessage,
        },
      },
      oldCtx,
    );
    await handlers.get("message_update")?.(
      {
        message: finalMessage,
        assistantMessageEvent: {
          type: "done",
          reason: "stop",
          message: finalMessage,
        },
      },
      oldCtx,
    );
    await firstSendStarted;
    await handlers.get("session_shutdown")?.({}, oldCtx);
    const newCtx = createRuntimeExtensionContext({ cwd });
    await handlers.get("session_start")?.({}, newCtx);
    releaseFirstSend();
    await flushMicrotasks(50);
    assert.equal(sendCalls, 1);
    await handlers.get("session_shutdown")?.({}, newCtx);
  } finally {
    releaseFirstSend();
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime skips proactive local result without Telegram lock ownership", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      assistant: { proactivePush: true },
    });
    await writeRuntimeTelegramLocks({
      default: {
        pid: process.pid + 1_000_000,
        cwd: "/repo/another-instance",
      },
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-non-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(sentBodies, []);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime delivers Telegram commentary before the active-turn final reply", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  const deliveredMarkdown: string[] = [];
  let dispatched = false;
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      dispatched = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init) ?? {};
    if (method === "deleteWebhook" || method === "setMyCommands") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "show checkpoints",
            },
          },
        ]);
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("stop", "AbortError"));
        });
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendRichMessage") {
      deliveredMarkdown.push(
        String(
          (body.rich_message as { markdown?: string } | undefined)?.markdown ??
            "",
        ),
      );
      return createRuntimeTelegramApiResponse({
        message_id: 100 + deliveredMarkdown.length,
      });
    }
    if (method === "sendMessage") {
      return createRuntimeTelegramApiResponse({ message_id: 200 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      assistant: { activity: "quiet", proactivePush: true },
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const idleCtx = createRuntimeExtensionContext();
    const activeCtx = createRuntimeExtensionContext({ isIdle: () => false });
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => dispatched);
    assert.match(
      getRuntimeHarnessTextBlock(sentMessages[0]).text ?? "",
      /^\[telegram\] show checkpoints/,
    );
    await handlers.get("agent_start")?.({}, activeCtx);
    const checkpointMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Checkpoint **visible**" }],
    };
    await handlers.get("message_update")?.(
      {
        message: checkpointMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Checkpoint **visible**",
          partial: checkpointMessage,
        },
      },
      activeCtx,
    );
    await handlers.get("message_update")?.(
      {
        message: checkpointMessage,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          partial: checkpointMessage,
        },
      },
      activeCtx,
    );
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Final **answer**" }],
    };
    await handlers.get("message_update")?.(
      {
        message: finalMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Final **answer**",
          partial: finalMessage,
        },
      },
      activeCtx,
    );
    await handlers.get("message_update")?.(
      {
        message: finalMessage,
        assistantMessageEvent: {
          type: "done",
          reason: "stop",
          message: finalMessage,
        },
      },
      activeCtx,
    );
    await handlers.get("agent_end")?.(
      { messages: [finalMessage] },
      activeCtx,
    );
    await waitForCondition(() => deliveredMarkdown.length === 2);
    assert.deepEqual(deliveredMarkdown, [
      "Checkpoint **visible**",
      "Final **answer**",
    ]);
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears queued follow-ups after a Telegram stop", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const fourthUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const sendTexts: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      if (getUpdatesCalls === 4) return fourthUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sendTexts.push(getRuntimeTelegramApiText(body));
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sendTexts.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const idleCtx = createRuntimeExtensionContext();
    let aborted = false;
    const activeCtx = createRuntimeExtensionContext({
      isIdle: () => false,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 11,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 12,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/stop",
          },
        },
      ]),
    );
    await waitForCondition(() => aborted);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    const dispatchCountBeforeNextTurn = sentMessages.length;
    fourthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message: {
            message_id: 13,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "new request",
          },
        },
      ]),
    );
    await waitForCondition(
      () => sentMessages.length === dispatchCountBeforeNextTurn + 1,
    );
    const promptText =
      getRuntimeHarnessTextBlock(sentMessages.at(-1)).text ?? "";
    assert.equal(promptText, "[telegram] new request");
    assert.equal(promptText.includes("follow up"), false);
    assert.equal(
      sendTexts.some((text) => text.startsWith("<b>⏹️ Aborted current turn.")),
      true,
    );
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime handles immediate status before queued prompt after agent end", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolved = false;
  let shutdownCtx: unknown;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 20,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const baseCtx = createRuntimeExtensionContext({
      cwd: process.cwd(),
      sessionManager: {
        getEntries: () => [],
      },
      modelRegistry: {
        refresh: () => {},
        getAvailable: () => [],
        isUsingOAuth: () => false,
      },
      getContextUsage: () => undefined,
    });
    const idleCtx = {
      ...baseCtx,
      isIdle: () => true,
    };
    const activeCtx = {
      ...baseCtx,
      isIdle: () => false,
    };
    shutdownCtx = idleCtx;
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 21,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/status",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 22,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after status",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.length >= 1);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length >= 3);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.match(runtimeEvents[1] ?? "", /^send:<b>Pi Telegram<\/b>/);
    assert.equal(
      runtimeEvents[2],
      "dispatch:[telegram] follow up after status",
    );
  } finally {
    if (shutdownCtx) await handlers.get("session_shutdown")?.({}, shutdownCtx);
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime opens immediate model menu before queued prompt after agent end", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 23,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const baseCtx = createRuntimeExtensionContext({
      cwd: process.cwd(),
      model: modelA,
      sessionManager: {
        getEntries: () => [],
      },
      modelRegistry: {
        refresh: () => {},
        getAvailable: () => [modelA, modelB],
        isUsingOAuth: () => false,
      },
      getContextUsage: () => undefined,
    });
    const idleCtx = {
      ...baseCtx,
      isIdle: () => true,
    };
    const activeCtx = {
      ...baseCtx,
      isIdle: () => false,
    };
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 24,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/model",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 25,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after model",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.length >= 1);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length >= 3, 5_000);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.equal(runtimeEvents[1], "send:<b>🤖 Choose a model:</b>");
    assert.equal(runtimeEvents[2], "dispatch:[telegram] follow up after model");
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime keeps queued turns blocked until compaction settles", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const failureParseModes: string[] = [];
  let compactHooks:
    | {
        onComplete: () => void;
        onError: (error: unknown) => void;
      }
    | undefined;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 30,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/compact",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) {
        return secondUpdates.promise;
      }
      if (getUpdatesCalls === 3) {
        return thirdUpdates.promise;
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      const text = getRuntimeTelegramApiText(body);
      runtimeEvents.push(`send:${text}`);
      if (text.includes("Compaction failed!")) {
        failureParseModes.push(String(body?.parse_mode ?? ""));
      }
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction") {
      runtimeEvents.push(
        `typing:${String(body?.chat_id ?? "")}:${String(body?.action ?? "")}`,
      );
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      runtimeEvents.push(`answer:${String(body?.callback_query_id ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      compact: (hooks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
      }) => {
        compactHooks = hooks;
        runtimeEvents.push("compact:start");
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:<b>Compact session?</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          callback_query: {
            id: "confirm-compact",
            from: { id: 77, is_bot: false, first_name: "Test" },
            message: {
              message_id: 101,
              chat: { id: 99, type: "private" },
            },
            data: "compact:confirm",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.includes("compact:start"));
    await waitForCondition(
      () =>
        runtimeEvents.includes("edit:<b>🗜 Compaction started.</b>") &&
        runtimeEvents.includes("typing:99:typing"),
    );
    assert.equal(
      runtimeEvents.indexOf("edit:<b>🗜 Compaction started.</b>") <
        runtimeEvents.indexOf("typing:99:typing"),
      true,
    );

    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 31,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after compaction",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    assert.equal(
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] follow up after compaction",
      ),
      false,
    );
    compactHooks?.onError(
      new Error(
        "Turn prefix summarization failed: This operation was aborted",
      ),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] follow up after compaction"),
    );
    await waitForCondition(() =>
      runtimeEvents.includes(
        "send:<b>⚠️ Compaction failed! This operation was aborted.</b>",
      ),
    );
    assert.deepEqual(failureParseModes, ["HTML"]);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime delivers the final answer before observed auto-compaction notices", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolve: (() => void) | undefined;
  const firstDispatched = new Promise<void>((resolve) => {
    firstDispatchResolve = resolve;
  });
  const secondUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolve?.();
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 41,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first telegram turn",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendMessageDraft" || method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await firstDispatched;
    await handlers.get("agent_start")?.({}, ctx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 42,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "queued during active turn",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    await handlers.get("session_before_compact")?.(
      { signal: new AbortController().signal },
      ctx,
    );
    await handlers.get("session_compact")?.({}, ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:**✅ Compaction completed.**"),
    );
    const midTurnStartedIndex = runtimeEvents.indexOf(
      "send:**🗜 Compaction started.**",
    );
    const midTurnCompletedIndex = runtimeEvents.indexOf(
      "send:**✅ Compaction completed.**",
    );
    assert.equal(midTurnStartedIndex < midTurnCompletedIndex, true);
    await handlers.get("session_before_compact")?.(
      { signal: new AbortController().signal },
      ctx,
    );
    await handlers.get("session_compact_failed")?.(
      {
        reason: "threshold",
        aborted: false,
        willRetry: false,
        fromExtension: false,
        errorMessage: "Auto-compaction failed: boom",
      },
      ctx,
    );
    await waitForCondition(() =>
      runtimeEvents.includes("send:**⚠️ Compaction failed.**"),
    );
    assert.equal(
      runtimeEvents.lastIndexOf("send:**🗜 Compaction started.**") <
        runtimeEvents.lastIndexOf("send:**⚠️ Compaction failed.**"),
      true,
    );
    const noticeBaseline = runtimeEvents.length;
    await handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      },
      ctx,
    );
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
      },
      ctx,
    );
    await handlers.get("session_before_compact")?.(
      { signal: new AbortController().signal },
      ctx,
    );
    await handlers.get("session_compact")?.({}, ctx);
    assert.equal(
      runtimeEvents
        .slice(noticeBaseline)
        .includes("send:**🗜 Compaction started.**"),
      false,
    );
    assert.equal(
      runtimeEvents
        .slice(noticeBaseline)
        .includes("send:**✅ Compaction completed.**"),
      false,
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued during active turn"),
      false,
    );
    await handlers.get("agent_settled")?.({}, ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:**✅ Compaction completed.**"),
    );
    const finalReplyIndex = runtimeEvents.findIndex(
      (event) => event === "send:done" || event === "edit:done",
    );
    const compactionStartedIndex = runtimeEvents.lastIndexOf(
      "send:**🗜 Compaction started.**",
    );
    const compactionCompletedIndex = runtimeEvents.lastIndexOf(
      "send:**✅ Compaction completed.**",
    );
    assert.notEqual(finalReplyIndex, -1);
    assert.equal(finalReplyIndex < compactionStartedIndex, true);
    assert.equal(compactionStartedIndex < compactionCompletedIndex, true);
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] queued during active turn"),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime coalesces media-group updates into one delayed dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 40,
              media_group_id: "album-1",
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              caption: "first caption",
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 41,
              media_group_id: "album-1",
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              caption: "second caption",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    assert.equal(runtimeEvents.length, 0);
    await waitForCondition(() => runtimeEvents.length === 1, 3000);
    assert.equal(
      runtimeEvents[0],
      "dispatch:[telegram] first caption\n\nsecond caption",
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime coalesces likely split long text updates into one dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 50,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "x".repeat(3600),
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 51,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "tail",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 1, 5000);
    await flushMicrotasks();
    assert.equal(runtimeEvents.length, 0);
    await waitForCondition(() => runtimeEvents.length === 1, 3000);
    assert.equal(
      runtimeEvents[0],
      `dispatch:[telegram] ${"x".repeat(3600)}\n\ntail`,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears pending split-text dispatch on shutdown", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 60,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "x".repeat(3600),
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    await handlers.get("session_shutdown")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(runtimeEvents, []);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears pending media-group dispatch on shutdown", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 61,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              media_group_id: "album-1",
              text: "album item",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    await handlers.get("session_shutdown")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(runtimeEvents, []);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime applies reaction priority and removal before the next dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const fourthUpdates = createRuntimeDeferredResponse();
  const fifthUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 30,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      if (getUpdatesCalls === 4) return fourthUpdates.promise;
      if (getUpdatesCalls === 5) return fifthUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const idleCtx = createRuntimeExtensionContext();
    const activeCtx = createRuntimeExtensionContext({
      isIdle: () => false,
    });
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 31,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "older waiting",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 32,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "newer waiting",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 4);
    fourthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message_reaction: {
            chat: { id: 99, type: "private" },
            message_id: 32,
            user: { id: 77, is_bot: false, first_name: "Test" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "👍" }],
            date: 1,
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 5);
    fifthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 5,
          message_reaction: {
            chat: { id: 99, type: "private" },
            message_id: 31,
            user: { id: 77, is_bot: false, first_name: "Test" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "👎" }],
            date: 2,
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 6);
    await flushMicrotasks(50);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length === 2);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.equal(runtimeEvents[1], "dispatch:[telegram] newer waiting");
    await handlers.get("agent_start")?.({}, activeCtx);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await flushMicrotasks();
    assert.deepEqual(runtimeEvents, [
      "dispatch:[telegram] first request",
      "dispatch:[telegram] newer waiting",
    ]);
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime applies idle model picks immediately and refreshes status", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const previousArgv = [...process.argv];
  const runtimeEvents: string[] = [];
  const statusEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", true);
  const setModels: Array<string> = [];
  const thinkingLevels: Array<string> = [];
  let shutdownCtx: unknown;
  const secondUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    getThinkingLevel: () => thinkingLevels.at(-1) ?? "medium",
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: (level) => {
      thinkingLevels.push(level);
    },
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 60,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    process.argv = [
      previousArgv[0] ?? "node",
      previousArgv[1] ?? "index.ts",
      "--models=anthropic/claude-b:high",
    ];
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      setStatus: (_slot, text) => {
        statusEvents.push(text);
      },
    });
    shutdownCtx = ctx;
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    const statusCountBeforePick = statusEvents.length;
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          callback_query: {
            id: "cb-idle-1",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:0",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => setModels.length === 1);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.deepEqual(thinkingLevels, ["high"]);
    assert.equal(callbackAnswers.includes("Switched to claude-b"), true);
    assert.equal(statusEvents.length > statusCountBeforePick, true);
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.startsWith("edit:<b>Pi Telegram</b>") ||
          event.startsWith("edit:<b>🤖 Choose a model:</b>"),
      ),
      true,
    );
  } finally {
    if (shutdownCtx) await handlers.get("session_shutdown")?.({}, shutdownCtx);
    process.argv = previousArgv;
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime switches model in flight and dispatches a continuation turn after abort", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let aborted = false;
  const setModels: Array<string> = [];
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 40,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 41,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] first request",
      ),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          callback_query: {
            id: "cb-1",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => aborted);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(
      callbackAnswers.includes("Switching to claude-b and continuing…"),
      true,
    );
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    await waitForCondition(() =>
      runtimeEvents.some((event) =>
        event.includes(
          "Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] first request"),
      true,
    );
    assert.equal(
      runtimeEvents.some((event) =>
        event.includes(
          "dispatch:[telegram] Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
      true,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime preserves long-session queue through abort, next, and model switch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let abortCount = 0;
  const setModels: Array<string> = [];
  const updates = Array.from({ length: 5 }, () =>
    createRuntimeDeferredResponse(),
  );
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 70,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      const update = updates[getUpdatesCalls - 2];
      if (update) return update.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        abortCount += 1;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:<b>🤖 Choose a model:</b>"),
    );
    updates[0].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 71,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first long-session request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] first long-session request"),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    updates[1].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 72,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "queued after abort",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 4);
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      false,
    );
    updates[2].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message: {
            message_id: 73,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/abort",
          },
        },
      ]),
    );
    await waitForCondition(() => abortCount === 1);
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      false,
    );
    updates[3].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 5,
          message: {
            message_id: 74,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/next",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    updates[4].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 6,
          callback_query: {
            id: "cb-long-session",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => abortCount === 2);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(
      callbackAnswers.includes("Switching to claude-b and continuing…"),
      true,
    );
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      true,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime delays model-switch abort until the active tool finishes", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let aborted = false;
  const setModels: Array<string> = [];
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 50,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 51,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] first request",
      ),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("tool_execution_start")?.({}, ctx);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          callback_query: {
            id: "cb-2",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() =>
      callbackAnswers.includes(
        "Switched to claude-b. Restarting after the current tool finishes…",
      ),
    );
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(aborted, false);
    await handlers.get("tool_execution_end")?.({}, ctx);
    await waitForCondition(() => aborted);
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    await waitForCondition(() =>
      runtimeEvents.some((event) =>
        event.includes(
          "dispatch:[telegram] Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});
