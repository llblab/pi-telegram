/**
 * Process-level shutdown regressions for the Telegram extension
 * Zones: process lifecycle, telegram polling, shutdown cleanup
 * Verifies session shutdown releases or unrefs runtime handles so headless processes can exit
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI_CLI_AVAILABLE = (() => {
  const result = spawnSync("pi", ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
})();

function runNodeScript(
  script: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
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
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`Child process did not exit. stdout=${stdout} stderr=${stderr}`),
      );
    }, options.timeoutMs ?? 2000);
    timeout.unref?.();
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForFileText(
  path: string,
  predicate: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (predicate(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const text = await readFile(path, "utf8").catch(() => "");
  assert.fail(`Timed out waiting for ${path}. Current text: ${text}`);
}

function runPiPrint(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn("pi", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi -p did not exit. stdout=${stdout} stderr=${stderr}`));
    }, options.timeoutMs ?? 10_000);
    timeout.unref?.();
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function createPiPrintFixtureExtension(tempDir: string): Promise<string> {
  const fixturePath = join(tempDir, "fixture-provider.ts");
  await writeFile(
    fixturePath,
    `import { writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";\n\n` +
      `export default function (pi) {\n` +
      `  const agentDir = process.env.PI_CODING_AGENT_DIR;\n` +
      `  if (process.env.PI_TELEGRAM_TEST_LOCK_MODE === "owner" && agentDir) {\n` +
      `    writeFileSync(join(agentDir, "locks.json"), JSON.stringify({ "@llblab/pi-telegram": { pid: process.pid } }) + "\\n");\n` +
      `  }\n` +
      `  globalThis.fetch = async (input, init = {}) => {\n` +
      `    const method = String(input).split("/").at(-1);\n` +
      `    if (method === "deleteWebhook") return { json: async () => ({ ok: true, result: true }) };\n` +
      `    if (method === "sendChatAction") return { json: async () => ({ ok: true, result: true }) };\n` +
      `    if (method === "sendMessage") {\n` +
      `      const marker = process.env.PI_TELEGRAM_TEST_SEND_MARKER;\n` +
      `      if (marker) writeFileSync(marker, String(init.body ?? "") + "\\n");\n` +
      `      return { json: async () => ({ ok: true, result: { message_id: 100 } }) };\n` +
      `    }\n` +
      `    if (method === "getUpdates") {\n` +
      `      const signal = init.signal;\n` +
      `      return new Promise((_, reject) => {\n` +
      `        const abort = () => reject(new DOMException("stop", "AbortError"));\n` +
      `        if (signal?.aborted) { abort(); return; }\n` +
      `        signal?.addEventListener("abort", abort, { once: true });\n` +
      `      });\n` +
      `    }\n` +
      `    throw new Error("Unexpected Telegram API method: " + method);\n` +
      `  };\n` +
      `  pi.registerProvider("fixture", {\n` +
      `    name: "Fixture Provider", baseUrl: "http://fixture.local", apiKey: "fixture", api: "fixture-stream",\n` +
      `    models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }],\n` +
      `    streamSimple(model) {\n` +
      `      const stream = createAssistantMessageEventStream();\n` +
      `      queueMicrotask(() => {\n` +
      `        const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };\n` +
      `        const text = "fixture ok";\n` +
      `        output.content.push({ type: "text", text: "" });\n` +
      `        stream.push({ type: "start", partial: output });\n` +
      `        stream.push({ type: "text_start", contentIndex: 0, partial: output });\n` +
      `        output.content[0].text = text;\n` +
      `        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });\n` +
      `        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });\n` +
      `        stream.push({ type: "done", reason: "stop", message: output });\n` +
      `        stream.end();\n` +
      `      });\n` +
      `      return stream;\n` +
      `    },\n` +
      `  });\n` +
      `}\n`,
    "utf8",
  );
  return fixturePath;
}

async function createPiPrintAgentDir(
  config: Record<string, unknown>,
  locks: Record<string, unknown> = {},
): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-pi-print-"));
  await writeFile(
    join(agentDir, "telegram.json"),
    JSON.stringify(config, null, "\t") + "\n",
    "utf8",
  );
  await writeFile(
    join(agentDir, "locks.json"),
    JSON.stringify(locks, null, "\t") + "\n",
    "utf8",
  );
  return agentDir;
}

async function runPiPrintWithTelegram(
  agentDir: string,
  fixtureExtension: string,
  env: NodeJS.ProcessEnv = {},
) {
  return runPiPrint(
    [
      "-p",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-session",
      "--extension",
      fixtureExtension,
      "--extension",
      join(REPO_ROOT, "index.ts"),
      "--provider",
      "fixture",
      "--model",
      "echo",
      "Say OK.",
    ],
    { env: { PI_CODING_AGENT_DIR: agentDir, ...env } },
  );
}

test("Child process sharing the agent dir does not poll while parent owns Telegram lock", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-process-lock-"));
  const markerPath = join(tempDir, "telegram-methods.log");
  const stopPath = join(tempDir, "stop");
  const agentDir = await createPiPrintAgentDir({
    botToken: "123:abc",
    allowedUserId: 77,
    lastUpdateId: 0,
  });
  const extensionUrl = new URL("../index.ts", import.meta.url).href;
  const parentScript = `
    import { appendFileSync, existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";

    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const markerPath = process.env.PI_TELEGRAM_TEST_METHOD_MARKER;
    const stopPath = process.env.PI_TELEGRAM_TEST_STOP_PATH;
    const cwd = "/repo/parent-owner";
    writeFileSync(
      join(agentDir, "locks.json"),
      JSON.stringify({ "@llblab/pi-telegram": { pid: process.pid, cwd } }) + "\\n",
    );
    globalThis.fetch = async (input, init = {}) => {
      const method = String(input).split("/").at(-1);
      appendFileSync(markerPath, "parent:" + method + "\\n");
      if (method === "deleteWebhook") {
        return { json: async () => ({ ok: true, result: true }) };
      }
      if (method === "getUpdates") {
        const signal = init.signal;
        return new Promise((_, reject) => {
          const abort = () => reject(new DOMException("stop", "AbortError"));
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error("Unexpected Telegram API method: " + method);
    };
    const handlers = new Map();
    const pi = {
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      sendUserMessage: () => {},
      getCommands: () => [],
      getThinkingLevel: () => "medium",
    };
    const extension = (await import(${JSON.stringify(extensionUrl)})).default;
    extension(pi);
    const ctx = {
      cwd,
      hasUI: false,
      ui: {
        theme: { fg: (_token, text) => text },
        setStatus: () => {},
        notify: () => {},
      },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
    };
    await handlers.get("session_start")?.({}, ctx);
    const timer = setInterval(async () => {
      if (!existsSync(stopPath)) return;
      clearInterval(timer);
      await handlers.get("session_shutdown")?.({}, ctx);
      process.exit(0);
    }, 20);
    setTimeout(() => process.exit(2), 5000).unref?.();
  `;
  const parent = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", parentScript],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_TELEGRAM_TEST_METHOD_MARKER: markerPath,
        PI_TELEGRAM_TEST_STOP_PATH: stopPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let parentStderr = "";
  parent.stderr.setEncoding("utf8");
  parent.stderr.on("data", (chunk) => {
    parentStderr += chunk;
  });
  const parentExit = new Promise<{ code: number | null }>((resolve) => {
    parent.on("exit", (code) => resolve({ code }));
  });
  try {
    await waitForFileText(markerPath, (text) => text.includes("parent:getUpdates"));
    const childScript = `
      import { appendFileSync } from "node:fs";
      const markerPath = process.env.PI_TELEGRAM_TEST_METHOD_MARKER;
      globalThis.fetch = async (input) => {
        const method = String(input).split("/").at(-1);
        appendFileSync(markerPath, "child:" + method + "\\n");
        return { json: async () => ({ ok: true, result: true }) };
      };
      const handlers = new Map();
      const pi = {
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: () => {},
        registerTool: () => {},
        sendUserMessage: () => {},
        getCommands: () => [],
        getThinkingLevel: () => "medium",
      };
      const extension = (await import(${JSON.stringify(extensionUrl)})).default;
      extension(pi);
      const ctx = {
        cwd: "/repo/parent-owner",
        hasUI: false,
        ui: {
          theme: { fg: (_token, text) => text },
          setStatus: () => {},
          notify: () => {},
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
        abort: () => {},
      };
      await handlers.get("session_start")?.({}, ctx);
      await new Promise((resolve) => setImmediate(resolve));
    `;
    const child = await runNodeScript(childScript, {
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_TELEGRAM_TEST_METHOD_MARKER: markerPath,
      },
    });
    assert.equal(child.code, 0, child.stderr);
    const methods = await readFile(markerPath, "utf8");
    assert.match(methods, /parent:getUpdates/);
    assert.doesNotMatch(methods, /child:getUpdates/);
  } finally {
    let parentError: unknown;
    try {
      await writeFile(stopPath, "stop", "utf8");
      const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          parent.kill("SIGKILL");
          reject(new Error(`Parent did not exit. stderr=${parentStderr}`));
        }, 2000);
        timer.unref?.();
      });
      const { code } = await Promise.race([parentExit, timeout]);
      if (code !== 0)
        parentError = new Error(`Parent exited with ${code}. stderr=${parentStderr}`);
    } catch (error) {
      parentError = error;
    }
    await rm(agentDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
    if (parentError) throw parentError;
  }
});

test("Direct Telegram tools refuse delivery from a non-owner process", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-direct-owner-"));
  const markerPath = join(tempDir, "telegram-methods.log");
  const attachmentPath = join(tempDir, "demo.txt");
  await writeFile(attachmentPath, "demo", "utf8");
  const agentDir = await createPiPrintAgentDir(
    {
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    },
    {
      "@llblab/pi-telegram": {
        pid: process.pid,
        cwd: "/repo/live-owner",
      },
    },
  );
  const extensionUrl = new URL("../index.ts", import.meta.url).href;
  try {
    const script = `
      import { appendFileSync } from "node:fs";
      const markerPath = process.env.PI_TELEGRAM_TEST_METHOD_MARKER;
      const attachmentPath = process.env.PI_TELEGRAM_TEST_ATTACHMENT_PATH;
      globalThis.fetch = async (input) => {
        const method = String(input).split("/").at(-1);
        appendFileSync(markerPath, method + "\\n");
        return { json: async () => ({ ok: true, result: { message_id: 100 } }) };
      };
      const handlers = new Map();
      const tools = new Map();
      const pi = {
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: () => {},
        registerTool: (definition) => tools.set(definition.name, definition),
        sendUserMessage: () => {},
        getCommands: () => [],
        getThinkingLevel: () => "medium",
      };
      const extension = (await import(${JSON.stringify(extensionUrl)})).default;
      extension(pi);
      const ctx = {
        cwd: "/repo/non-owner",
        hasUI: false,
        ui: {
          theme: { fg: (_token, text) => text },
          setStatus: () => {},
          notify: () => {},
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
        abort: () => {},
      };
      await handlers.get("session_start")?.({}, ctx);
      const failures = [];
      for (const [name, params] of [
        ["telegram_message", { text: "hello" }],
        ["telegram_attach", { paths: [attachmentPath] }],
      ]) {
        try {
          await tools.get(name)?.execute("tool-call", params);
          failures.push(name + ":unexpected-success");
        } catch (error) {
          failures.push(name + ":" + error.message);
        }
      }
      await handlers.get("session_shutdown")?.({}, ctx);
      console.log(failures.join("\\n"));
    `;
    const result = await runNodeScript(script, {
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_TELEGRAM_TEST_METHOD_MARKER: markerPath,
        PI_TELEGRAM_TEST_ATTACHMENT_PATH: attachmentPath,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /telegram_message:Telegram direct delivery requires this π instance to own \/telegram-connect/,
    );
    assert.match(
      result.stdout,
      /telegram_attach:Telegram direct delivery requires this π instance to own \/telegram-connect/,
    );
    await assert.rejects(() => readFile(markerPath, "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test(
  "pi -p with Telegram extension and no active lock exits",
  { skip: !PI_CLI_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-pi-print-"));
    const fixtureExtension = await createPiPrintFixtureExtension(tempDir);
    const agentDir = await createPiPrintAgentDir({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    try {
      const result = await runPiPrintWithTelegram(agentDir, fixtureExtension);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null, result.stderr);
      assert.match(result.stdout, /fixture ok/);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "pi -p with proactive config and Telegram-owned lock exits",
  { skip: !PI_CLI_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-pi-print-"));
    const fixtureExtension = await createPiPrintFixtureExtension(tempDir);
    const agentDir = await createPiPrintAgentDir({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: true,
    });
    try {
      const result = await runPiPrintWithTelegram(agentDir, fixtureExtension, {
        PI_TELEGRAM_TEST_LOCK_MODE: "owner",
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null, result.stderr);
      assert.match(result.stdout, /fixture ok/);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "pi -p non-owner skips proactive Telegram result",
  { skip: !PI_CLI_AVAILABLE },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-pi-print-"));
    const fixtureExtension = await createPiPrintFixtureExtension(tempDir);
    const markerPath = join(tempDir, "send-marker.json");
    const agentDir = await createPiPrintAgentDir(
      {
        botToken: "123:abc",
        allowedUserId: 77,
        lastUpdateId: 0,
        proactivePush: true,
      },
      {
        "@llblab/pi-telegram": {
          pid: process.pid,
          cwd: "/repo/another-live-owner",
        },
      },
    );
    try {
      const result = await runPiPrintWithTelegram(agentDir, fixtureExtension, {
        PI_TELEGRAM_TEST_SEND_MARKER: markerPath,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null, result.stderr);
      assert.match(result.stdout, /fixture ok/);
      await assert.rejects(() => readFile(markerPath, "utf8"), {
        code: "ENOENT",
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test("Extension session shutdown without active lock lets process exit", async () => {
  const extensionUrl = new URL("../index.ts", import.meta.url).href;
  const result = await runNodeScript(`
    import { mkdtemp, rm, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";

    const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-process-shutdown-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({ botToken: "123:abc", allowedUserId: 77, lastUpdateId: 0 }) + "\\n",
      "utf8",
    );
    await writeFile(join(agentDir, "locks.json"), "{}\\n", "utf8");

    const handlers = new Map();
    const pi = {
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      sendUserMessage: () => {},
      getCommands: () => [],
      getThinkingLevel: () => "medium",
    };
    const extension = (await import(${JSON.stringify(extensionUrl)})).default;
    extension(pi);
    const ctx = {
      cwd: "/repo/process-shutdown-no-lock",
      hasUI: false,
      ui: {
        theme: { fg: (_token, text) => text },
        setStatus: () => {},
        notify: () => {},
      },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
    };
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(agentDir, { recursive: true, force: true });
  `);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null, result.stderr);
});

test("Extension session shutdown lets an active polling owner process exit", async () => {
  const extensionUrl = new URL("../index.ts", import.meta.url).href;
  const result = await runNodeScript(`
    import { mkdtemp, rm, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";

    const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-process-shutdown-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const cwd = "/repo/process-shutdown";
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({ botToken: "123:abc", allowedUserId: 77, lastUpdateId: 0 }) + "\\n",
      "utf8",
    );
    await writeFile(
      join(agentDir, "locks.json"),
      JSON.stringify({ "@llblab/pi-telegram": { pid: process.pid, cwd } }) + "\\n",
      "utf8",
    );

    globalThis.fetch = async (input, init = {}) => {
      const method = String(input).split("/").at(-1);
      if (method === "deleteWebhook") {
        return { json: async () => ({ ok: true, result: true }) };
      }
      if (method === "getUpdates") {
        const signal = init.signal;
        return new Promise((_, reject) => {
          const abort = () => reject(new DOMException("stop", "AbortError"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error("Unexpected Telegram API method: " + method);
    };

    const handlers = new Map();
    const pi = {
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
      sendUserMessage: () => {},
      getCommands: () => [],
      getThinkingLevel: () => "medium",
    };
    const extension = (await import(${JSON.stringify(extensionUrl)})).default;
    extension(pi);
    const ctx = {
      cwd,
      hasUI: false,
      ui: {
        theme: { fg: (_token, text) => text },
        setStatus: () => {},
        notify: () => {},
      },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
    };
    await handlers.get("session_start")?.({}, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(agentDir, { recursive: true, force: true });
  `);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null, result.stderr);
});
