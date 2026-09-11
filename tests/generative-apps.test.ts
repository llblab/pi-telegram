/**
 * Generative App runtime regression tests
 * Covers canonical identity, installation, invocation, state transactions, recovery, bounded processes, and Tool registration
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";


import {
  bindGenerativeApp,
  formatDisplayedGenerativeAppToolOutput,
  formatGenerativeAppToolError,
  formatGenerativeAppToolOutput,
  installGenerativeApp,
  invokeGenerativeApp,
  invokeGenerativeAppBoundAction,
  parseGenerativeAppBoundAction,
  registerTelegramBindTool,
  resolveGenerativeAppDir,
  resolveGenerativeAppModulePath,
} from "../lib/generative-apps.ts";
import type { ExtensionAPI } from "../lib/pi.ts";

const execFileAsync = promisify(execFile);

async function writeApp(root: string, app: string, source: string): Promise<string> {
  const path = join(root, `${app}.mjs`);
  await writeFile(path, source, "utf8");
  return path;
}

const statefulApp = `
export function init({ argument }) {
  if (argument?.fail) throw new Error("init rejected");
  return { state: { count: argument?.count ?? 0 }, output: "ready" };
}
export function increment({ state, argument }) {
  const next = { count: state.count + (argument ?? 1) };
  return { state: next, output: String(next.count) };
}
export function inspect({ state }) {
  return { output: JSON.stringify(state) };
}
export function invalid_view() {
  return { output: "invalid", viewMode: "replace" };
}
`;

test("Generative App identity resolves only canonical managed paths", () => {
  const agentDir = resolve("/tmp/agent");
  assert.equal(resolveGenerativeAppDir(agentDir, "poker"), join(agentDir, "genapps", "poker"));
  assert.equal(
    resolveGenerativeAppModulePath(agentDir, "poker"),
    join(agentDir, "genapps", "poker", "poker.mjs"),
  );
  for (const app of ["Poker", "../poker", "poker::call", "poker_name", "-poker"]) {
    assert.throws(() => resolveGenerativeAppDir(agentDir, app), /name must match/);
  }
});

test("Generative App bound-action parser separates ordinary prompts from strict complete actions", () => {
  assert.equal(parseGenerativeAppBoundAction("ordinary prompt"), undefined);
  assert.deepEqual(parseGenerativeAppBoundAction("poker::fold"), {
    method: "fold",
    app: "poker",
  });
  assert.deepEqual(parseGenerativeAppBoundAction('poker::call({"amount":18})'), {
    argument: { amount: 18 },
    method: "call",
    app: "poker",
  });
  for (const malformed of [
    "poker::fold()",
    "Poker::fold",
    "poker::fold({amount:18})",
    "poker::fold trailing",
    "../poker::fold",
  ]) {
    assert.throws(() => parseGenerativeAppBoundAction(malformed), /Malformed|strict JSON/);
  }
});

test("Generative App install initializes state and later methods commit or remain output-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(root, "counter", statefulApp);
    const installed = await installGenerativeApp({
      agentDir,
      argument: { count: 2 },
      app: "counter",
      script,
    });
    assert.match(installed.generation, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(installed, {
      generation: installed.generation,
      method: "init",
      output: "ready",
      app: "counter",
      revision: 0,
      stateChanged: true,
      viewMode: "new",
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(agentDir, "genapps", "counter", "state.json"), "utf8")),
      { count: 2 },
    );
    const incremented = await invokeGenerativeAppBoundAction({
      agentDir,
      prompt: "counter::increment(3)",
    });
    assert.ok(incremented);
    assert.equal(incremented.output, "5");
    assert.equal(incremented.revision, 1);
    await assert.rejects(
      invokeGenerativeApp({
        agentDir,
        expectedRevision: 0,
        method: "increment",
        app: "counter",
      }),
      /action is stale: expected revision 0, current revision 1/,
    );
    const journalPath = join(agentDir, "genapps", "counter", "states.jsonl");
    const beforeInspect = await readFile(journalPath, "utf8");
    const inspected = await invokeGenerativeApp({
      agentDir,
      method: "inspect",
      app: "counter",
    });
    assert.equal(inspected.output, '{"count":5}');
    assert.equal(inspected.stateChanged, false);
    assert.equal(await readFile(journalPath, "utf8"), beforeInspect);
    await assert.rejects(
      invokeGenerativeApp({
        agentDir,
        method: "invalid_view",
        app: "counter",
      }),
      /viewMode must be new or edit/,
    );
    assert.equal(await readFile(journalPath, "utf8"), beforeInspect);
    const reset = await bindGenerativeApp({
      agentDir,
      argument: { count: 9 },
      method: "init",
      app: "counter",
    });
    assert.equal(reset.revision, 0);
    const resetLines = (await readFile(journalPath, "utf8")).trim().split("\n");
    assert.equal(resetLines.length, 1);
    assert.equal(JSON.parse(resetLines[0]!).state.count, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App initialization failure preserves a working install and rejects silent replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(root, "counter", statefulApp);
    await installGenerativeApp({ agentDir, app: "counter", script });
    const appDir = resolveGenerativeAppDir(agentDir, "counter");
    const previousState = await readFile(join(appDir, "state.json"), "utf8");
    const previousJournal = await readFile(join(appDir, "states.jsonl"), "utf8");
    await assert.rejects(
      invokeGenerativeApp({
        agentDir,
        argument: { fail: true },
        method: "init",
        app: "counter",
      }),
      /init rejected/,
    );
    assert.equal(await readFile(join(appDir, "state.json"), "utf8"), previousState);
    assert.equal(await readFile(join(appDir, "states.jsonl"), "utf8"), previousJournal);
    await assert.rejects(
      installGenerativeApp({ agentDir, app: "counter", script }),
      /already installed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App explicit replacement publishes only an initialized new application", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(root, "counter", statefulApp);
    await installGenerativeApp({ agentDir, argument: { count: 2 }, app: "counter", script });
    const appDir = resolveGenerativeAppDir(agentDir, "counter");
    const replacement = statefulApp.replace('output: "ready"', 'output: "updated"');
    await writeFile(script, replacement, "utf8");
    const replaced = await installGenerativeApp({
      agentDir,
      argument: { count: 7 },
      app: "counter",
      replace: true,
      script,
    });
    assert.equal(replaced.output, "updated");
    assert.equal(replaced.revision, 0);
    assert.deepEqual(
      JSON.parse(await readFile(join(appDir, "state.json"), "utf8")),
      { count: 7 },
    );
    assert.equal(
      (await readFile(join(appDir, "states.jsonl"), "utf8")).trim().split("\n").length,
      1,
    );
    assert.match(await readFile(resolveGenerativeAppModulePath(agentDir, "counter"), "utf8"), /updated/);

    const previousModule = await readFile(resolveGenerativeAppModulePath(agentDir, "counter"), "utf8");
    const previousState = await readFile(join(appDir, "state.json"), "utf8");
    const previousJournal = await readFile(join(appDir, "states.jsonl"), "utf8");
    await writeFile(script, statefulApp.replace("export function init({ argument }) {", "export function init({ argument }) { throw new Error('replacement rejected');"), "utf8");
    await assert.rejects(
      installGenerativeApp({ agentDir, app: "counter", replace: true, script }),
      /replacement rejected/,
    );
    assert.equal(await readFile(resolveGenerativeAppModulePath(agentDir, "counter"), "utf8"), previousModule);
    assert.equal(await readFile(join(appDir, "state.json"), "utf8"), previousState);
    assert.equal(await readFile(join(appDir, "states.jsonl"), "utf8"), previousJournal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App replacement fences buttons from the previous installation generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(root, "counter", statefulApp);
    const first = await installGenerativeApp({ agentDir, app: "counter", script });
    await writeFile(script, statefulApp.replace('output: "ready"', 'output: "v2"'));
    const replacement = await installGenerativeApp({
      agentDir,
      app: "counter",
      replace: true,
      script,
    });
    assert.notEqual(replacement.generation, first.generation);
    await assert.rejects(
      invokeGenerativeApp({
        agentDir,
        expectedGeneration: first.generation,
        expectedRevision: 0,
        method: "increment",
        app: "counter",
      }),
      /expected generation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App replacement requires an existing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(root, "counter", statefulApp);
    await assert.rejects(
      installGenerativeApp({ agentDir, app: "counter", replace: true, script }),
      /not installed and cannot be replaced/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App method arguments round-trip scalar, object, and absent shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(
      root,
      "echo",
      `
export function init() { return { state: {}, output: "ready" }; }
export function echo({ argument }) { return { output: JSON.stringify(argument ?? null) }; }
`,
    );
    await installGenerativeApp({ agentDir, app: "echo", script });
    assert.equal(
      (await invokeGenerativeApp({ agentDir, method: "echo", app: "echo" })).output,
      "null",
    );
    assert.equal(
      (await invokeGenerativeApp({ agentDir, argument: 7, method: "echo", app: "echo" })).output,
      "7",
    );
    assert.equal(
      (await invokeGenerativeApp({
        agentDir,
        argument: { a: [1, 2], b: "x" },
        method: "echo",
        app: "echo",
      })).output,
      '{"a":[1,2],"b":"x"}',
    );
    assert.equal(
      (await invokeGenerativeAppBoundAction({
        agentDir,
        prompt: 'echo::echo({"nested":{"n":true}})',
      }))?.output,
      '{"nested":{"n":true}}',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App method failure leaves state and journal unchanged and later calls succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(
      root,
      "counter",
      `
export function init() { return { state: { count: 0 }, output: "ready" }; }
export function boom() { throw new Error("kaboom"); }
export function increment({ state }) { return { state: { count: state.count + 1 }, output: "ok" }; }
`,
    );
    await installGenerativeApp({ agentDir, app: "counter", script });
    const appDir = resolveGenerativeAppDir(agentDir, "counter");
    const previousState = await readFile(join(appDir, "state.json"), "utf8");
    const previousJournal = await readFile(join(appDir, "states.jsonl"), "utf8");
    await assert.rejects(
      invokeGenerativeApp({ agentDir, method: "boom", app: "counter" }),
      /kaboom/,
    );
    assert.equal(await readFile(join(appDir, "state.json"), "utf8"), previousState);
    assert.equal(await readFile(join(appDir, "states.jsonl"), "utf8"), previousJournal);
    const incremented = await invokeGenerativeApp({
      agentDir,
      method: "increment",
      app: "counter",
    });
    assert.equal(incremented.output, "ok");
    assert.equal(incremented.revision, 1);
    assert.deepEqual(
      JSON.parse(await readFile(join(appDir, "state.json"), "utf8")),
      { count: 1 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App rejects oversized argument, output, and state before durable mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(
      root,
      "limits",
      `
export function init() { return { state: {}, output: "ready" }; }
export function inspect() { return { output: "ok" }; }
export function huge_output() { return { output: "x".repeat(70 * 1024) }; }
export function huge_state() { return { state: { blob: "y".repeat(270 * 1024) }, output: "ok" }; }
`,
    );
    await installGenerativeApp({ agentDir, app: "limits", script });
    const appDir = resolveGenerativeAppDir(agentDir, "limits");
    const previousState = await readFile(join(appDir, "state.json"), "utf8");
    const previousJournal = await readFile(join(appDir, "states.jsonl"), "utf8");
    await assert.rejects(
      invokeGenerativeApp({
        agentDir,
        argument: { blob: "z".repeat(270 * 1024) },
        method: "inspect",
        app: "limits",
      }),
      /argument exceeds 262144 bytes/,
    );
    await assert.rejects(
      invokeGenerativeApp({ agentDir, method: "huge_output", app: "limits" }),
      /output exceeds 65536 bytes/,
    );
    await assert.rejects(
      invokeGenerativeApp({ agentDir, method: "huge_state", app: "limits" }),
      /state exceeds 262144 bytes/,
    );
    assert.equal(await readFile(join(appDir, "state.json"), "utf8"), previousState);
    assert.equal(await readFile(join(appDir, "states.jsonl"), "utf8"), previousJournal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App install rejects an oversized module", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(
      root,
      "huge",
      `/*${"z".repeat(1024 * 1024)}*/\nexport function init() { return { state: {}, output: "ready" }; }\n`,
    );
    await assert.rejects(
      installGenerativeApp({ agentDir, app: "huge", script }),
      /module exceeds 1048576 bytes/,
    );
    await assert.rejects(
      readdir(resolveGenerativeAppDir(agentDir, "huge")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App install rejects noncanonical scripts and source symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const wrongStem = await writeApp(root, "source", statefulApp);
    await assert.rejects(
      installGenerativeApp({ agentDir, app: "counter", script: wrongStem }),
      /stem must equal/,
    );
    const target = await writeApp(root, "actual", statefulApp);
    const linked = join(root, "counter.mjs");
    await symlink(target, linked);
    await assert.rejects(
      installGenerativeApp({ agentDir, app: "counter", script: linked }),
      /regular non-symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App install rejects a symlinked managed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  const outside = join(root, "outside");
  try {
    await mkdir(agentDir);
    await mkdir(outside);
    await symlink(outside, join(agentDir, "genapps"));
    const script = await writeApp(root, "counter", statefulApp);
    await assert.rejects(
      installGenerativeApp({ agentDir, app: "counter", script }),
      /managed non-symlink directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App invocation recovers current state from the last complete journal line", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(root, "counter", statefulApp);
    await installGenerativeApp({ agentDir, app: "counter", script });
    const appDir = resolveGenerativeAppDir(agentDir, "counter");
    await writeFile(join(appDir, "state.json"), '{"count":99}\n', "utf8");
    await writeFile(
      join(appDir, "states.jsonl"),
      '{"revision":0,"method":"init","state":{"count":0}}\n{"revision":1',
      "utf8",
    );
    const inspected = await invokeGenerativeApp({ agentDir, method: "inspect", app: "counter" });
    assert.equal(inspected.output, '{"count":0}');
    const incremented = await invokeGenerativeApp({
      agentDir,
      method: "increment",
      app: "counter",
    });
    assert.equal(incremented.output, "1");
    assert.equal(
      (await invokeGenerativeApp({ agentDir, method: "inspect", app: "counter" })).output,
      '{"count":1}',
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(appDir, "state.json"), "utf8")),
      { count: 1 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App invocation reloads same-size module edits even when file timestamps match", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(
      root,
      "probe",
      `
export function init() { return { state: {}, output: "ready" }; }
export function inspect() { return { output: "old" }; }
`,
    );
    await installGenerativeApp({ agentDir, app: "probe", script });
    const modulePath = resolveGenerativeAppModulePath(agentDir, "probe");
    const installedMetadata = await stat(modulePath);
    const fixedTime = new Date(Math.floor(installedMetadata.mtimeMs / 1_000) * 1_000);
    await utimes(modulePath, fixedTime, fixedTime);
    const before = await stat(modulePath);
    assert.equal(
      (await invokeGenerativeApp({ agentDir, method: "inspect", app: "probe" })).output,
      "old",
    );
    const updated = (await readFile(modulePath, "utf8")).replace('output: "old"', 'output: "new"');
    await writeFile(modulePath, updated, "utf8");
    await utimes(modulePath, before.atime, before.mtime);
    const after = await stat(modulePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(
      (await invokeGenerativeApp({ agentDir, method: "inspect", app: "probe" })).output,
      "new",
    );
    assert.deepEqual(
      (await readdir(resolveGenerativeAppDir(agentDir, "probe")))
        .filter((name) => name.endsWith(".load.mjs")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App transition lock serializes sibling processes and recovers a dead owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(
      root,
      "counter",
      `
export function init() { return { state: { count: 0 }, output: "ready" }; }
export async function increment({ state }) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { state: { count: state.count + 1 }, output: String(state.count + 1) };
}
`,
    );
    await installGenerativeApp({ agentDir, app: "counter", script });
    const appDir = resolveGenerativeAppDir(agentDir, "counter");
    const lockDir = `${appDir}.transition.lock`;
    await mkdir(lockDir);
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "dead" }),
      "utf8",
    );
    const moduleUrl = pathToFileURL(join(process.cwd(), "lib", "generative-apps.ts")).href;
    const childScript = `
import { invokeGenerativeApp } from ${JSON.stringify(moduleUrl)};
const result = await invokeGenerativeApp({ agentDir: process.argv[1], method: "increment", app: "counter" });
process.stdout.write(result.output);
`;
    const args = [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      childScript,
      agentDir,
    ];
    const results = await Promise.all([
      execFileAsync(process.execPath, args, { cwd: process.cwd() }),
      execFileAsync(process.execPath, args, { cwd: process.cwd() }),
    ]);
    assert.deepEqual(results.map((result) => result.stdout).sort(), ["1", "2"]);
    assert.deepEqual(
      JSON.parse(await readFile(join(appDir, "state.json"), "utf8")),
      { count: 2 },
    );
    assert.equal(
      (await readFile(join(appDir, "states.jsonl"), "utf8")).trim().split("\n").length,
      3,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App bounded process port uses argv execution and captures structured output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const script = await writeApp(
      root,
      "probe",
      `
export function init() { return { state: {}, output: "ready" }; }
export async function inspect({ run, argument }) {
  const result = await run({ command: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", argument], cwd: ${JSON.stringify(root)} });
  return { output: JSON.stringify(result) };
}
`,
    );
    await installGenerativeApp({ agentDir, app: "probe", script });
    const result = await invokeGenerativeApp({
      agentDir,
      argument: "literal;not-a-shell",
      method: "inspect",
      app: "probe",
    });
    assert.deepEqual(JSON.parse(result.output), {
      code: 0,
      killed: false,
      stderr: "",
      stdout: "literal;not-a-shell",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App worker bounds synchronous methods and cancels in-flight processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const hanging = await writeApp(
      root,
      "hang",
      `
export function init() { return { state: {}, output: "ready" }; }
export function block() { while (true) {} }
`,
    );
    await installGenerativeApp({ agentDir, app: "hang", script: hanging });
    await assert.rejects(
      invokeGenerativeApp({
        agentDir,
        method: "block",
        methodTimeoutMs: 100,
        app: "hang",
      }),
      /timed out/,
    );

    const marker = join(root, "late.txt");
    const cancellable = await writeApp(
      root,
      "cancel",
      `
export function init() { return { state: {}, output: "ready" }; }
export async function mutate({ run }) {
  await run({
    command: process.execPath,
    args: ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 300)`) }],
    cwd: ${JSON.stringify(root)},
    timeoutMs: 1000,
  });
  return { state: { committed: true }, output: "done" };
}
`,
    );
    await installGenerativeApp({ agentDir, app: "cancel", script: cancellable });
    const execution = new AbortController();
    const pending = invokeGenerativeApp({
      agentDir,
      execution: {
        assertCurrent: () => {
          if (execution.signal.aborted) throw new Error("stale execution");
        },
        signal: execution.signal,
      },
      method: "mutate",
      app: "cancel",
    });
    setTimeout(() => execution.abort(), 50);
    await assert.rejects(pending, /cancelled|stale execution/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(readFile(marker), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telegram_bind Tool output contributes exactly one leading newline", () => {
  assert.equal(formatGenerativeAppToolOutput("ready"), "\nready");
  assert.equal(formatGenerativeAppToolOutput("\n\nready"), "\nready");
  assert.equal(formatGenerativeAppToolOutput(""), "\n(Generative App returned no output)");
  assert.equal(formatGenerativeAppToolError(new Error("broken")).message, "\nbroken");
  assert.equal(formatGenerativeAppToolError(new Error("\n\nbroken")).message, "\nbroken");
  assert.match(formatDisplayedGenerativeAppToolOutput(), /delivered directly/u);
  assert.match(formatDisplayedGenerativeAppToolOutput(), /Do not repeat/u);
});

test("telegram_bind displays app output directly in an active Telegram turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  let tool: {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  } | undefined;
  const pi = {
    registerTool(definition: typeof tool) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;
  const deliveries: unknown[][] = [];
  try {
    const script = await writeApp(root, "counter", statefulApp);
    registerTelegramBindTool(pi, {
      agentDir,
      getActiveTurn: () => ({
        chatId: 123,
        replyToMessageId: 456,
        target: { chatId: 123, threadId: 789 },
      }),
      planOutput(markdown, options) {
        assert.match(options.binding.generation, /^[0-9a-f-]{36}$/u);
        assert.deepEqual(options.binding, {
          generation: options.binding.generation,
          app: "counter",
          revision: 0,
        });
        return { markdown: `planned:${markdown}`, replyMarkup: { inline_keyboard: [] } };
      },
      async sendMarkdownReply(...args) {
        deliveries.push(args);
        return 654;
      },
    });
    const installed = await tool!.execute("call-1", {
      app: "counter",
      script,
    }) as {
      content: Array<{ text: string }>;
      details: { displayed: boolean; messageId: number };
    };
    assert.equal(installed.details.displayed, true);
    assert.equal(installed.details.messageId, 654);
    assert.match(installed.content[0]?.text ?? "", /Do not repeat/u);
    assert.doesNotMatch(installed.content[0]?.text ?? "", /ready/u);
    assert.deepEqual(deliveries, [[
      123,
      456,
      "planned:ready",
      {
        replyMarkup: { inline_keyboard: [] },
        target: { chatId: 123, threadId: 789 },
      },
    ]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telegram_bind Tool exposes mutually exclusive install and invocation shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  let tool: {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    name: string;
    parameters: unknown;
  } | undefined;
  const pi = {
    registerTool(definition: typeof tool) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;
  try {
    const script = await writeApp(root, "counter", statefulApp);
    registerTelegramBindTool(pi, { agentDir });
    assert.equal(tool?.name, "telegram_bind");
    assert.equal((tool?.parameters as { type?: unknown }).type, "object");
    assert.equal("anyOf" in (tool?.parameters as object), false);
    const parameters = tool?.parameters as { properties?: Record<string, unknown> };
    // Provider compatibility: no recursion, reference resolution, or TypeBox markers
    // may leak into the serialized schema (OpenAI 400 recursion, Gemini ~optional).
    const serializedParameters = JSON.stringify(parameters);
    assert.equal(serializedParameters.includes("$defs"), false);
    assert.equal(serializedParameters.includes("$ref"), false);
    assert.equal(serializedParameters.includes("~optional"), false);
    assert.equal(serializedParameters.includes('"argument":true'), false);
    type JsonValueUnion = {
      anyOf?: Array<{ type?: unknown; items?: JsonValueUnion; additionalProperties?: JsonValueUnion }> };
    const argumentSchema = parameters.properties?.argument as JsonValueUnion;
    const scalarTypes = ["null", "boolean", "number", "string"];
    let union: JsonValueUnion | undefined = argumentSchema;
    for (let depth = 0; depth < 4; depth += 1) {
      assert.deepEqual(union?.anyOf?.map(branch => branch.type), [...scalarTypes, "array", "object"]);
      assert.deepEqual(union?.anyOf?.[5]?.additionalProperties, union?.anyOf?.[4]?.items);
      union = union?.anyOf?.[4]?.items;
    }
    assert.deepEqual(union?.anyOf?.map(branch => branch.type), scalarTypes);

    const installed = await tool!.execute("call-1", {
      app: "counter",
      script,
    }) as { details: { revision: number }; content: Array<{ text: string }> };
    assert.equal(installed.details.revision, 0);
    assert.equal(installed.content[0]?.text, "\nready");
    await assert.rejects(
      tool!.execute("call-2", {
        method: "missing",
        app: "counter",
      }),
      (error: unknown) =>
        error instanceof Error && /^\nGenerative App counter does not export method missing\./u.test(error.message),
    );
    await assert.rejects(
      bindGenerativeApp({ agentDir, app: "counter" }),
      /exactly one of script or method/,
    );
    await assert.rejects(
      bindGenerativeApp({ agentDir, method: "inspect", app: "counter", replace: true }),
      /replace is valid only with script/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
