/**
 * Regression tests for the pi SDK adapter boundary
 * Covers narrow bridge-facing helpers over concrete pi context contracts
 * Zones: pi agent sdk boundary, shared adapters
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as Pi from "../lib/pi.ts";
import { runNodeEval } from "./fixtures/node-eval.ts";

import {
  canStartPollingInExtensionContext,
  compactExtensionContext,
  createExtensionApiRuntimePorts,
  createScopedModelPatternPersister,
  type ExtensionContext,
  getExtensionContextCwd,
  getExtensionContextSessionId,
  formatPollingStartBlockedByRunMode,
  getExtensionContextMode,
  getExtensionContextModel,
  hasExtensionContextPendingMessages,
  isExtensionContextIdle,
  isExtensionContextAbortRequested,
  isExtensionContextPassiveRunMode,
  normalizeSettingsManager,
} from "../lib/pi.ts";

type PiRuntimeApiHarness = Parameters<
  typeof createExtensionApiRuntimePorts
>[0] & {
  events: string[];
};

type PiRuntimeModel = Parameters<PiRuntimeApiHarness["setModel"]>[0];

function createHarnessModel(id: string): PiRuntimeModel {
  return { id } as PiRuntimeModel;
}

function getHarnessModelId(model: PiRuntimeModel): string {
  return String(Reflect.get(Object(model), "id"));
}

test("Original Pi command provider capture pins API callable without lookup effects", () => {
  let calls = 0, receiver: unknown;
  const api = { getCommands() { calls++; receiver = this; return []; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const ports = createExtensionApiRuntimePorts(api, true);
  assert.equal(typeof ports.captureCommandProvider, "function");
  const capture = ports.captureCommandProvider!(); assert.equal(Pi.readPiCommandProviderCapture(capture, ports), capture); assert.equal(calls, 0); assert.equal(capture.assertCallable(), undefined);
  assert.deepEqual(capture.getCommands(), []); assert.equal(calls, 1); assert.equal(receiver, api); assert.ok(Object.isFrozen(capture));
});


for (const kind of ["api-method", "api-getter", "api-inherited", "port-method", "port-getter", "capture-method", "capture-getter"] as const)
test(`Original Pi command provider observed own-data loss is sticky without getter probes (${kind})`, () => {
  let calls = 0, gets = 0;
  const api = { getCommands() { calls++; return []; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const ports = createExtensionApiRuntimePorts(api, true), originalCapture = ports.captureCommandProvider!, proof = originalCapture();
  const apiDescriptor = Object.getOwnPropertyDescriptor(api, "getCommands")!, portDescriptor = Object.getOwnPropertyDescriptor(ports, "getCommands")!, captureDescriptor = Object.getOwnPropertyDescriptor(ports, "captureCommandProvider")!, prototype = Object.getPrototypeOf(api);
  try {
    if (kind === "api-method") api.getCommands = () => [];
    if (kind === "api-getter") Object.defineProperty(api, "getCommands", { get() { gets++; return apiDescriptor.value; }, configurable: true });
    if (kind === "api-inherited") { delete (api as unknown as Record<string, unknown>).getCommands; Object.setPrototypeOf(api, { getCommands: apiDescriptor.value }); }
    if (kind === "port-method") ports.getCommands = () => [];
    if (kind === "port-getter") Object.defineProperty(ports, "getCommands", { get() { gets++; return portDescriptor.value; }, configurable: true });
    if (kind === "capture-method") ports.captureCommandProvider = () => proof;
    if (kind === "capture-getter") Object.defineProperty(ports, "captureCommandProvider", { get() { gets++; return originalCapture; }, configurable: true });
    assert.throws(proof.assertCallable, /command provider callable/); assert.throws(originalCapture, /command provider callable/); assert.throws(proof.getCommands, /command provider callable/);
    assert.equal(calls, 0); assert.equal(gets, 0);
  } finally { Object.setPrototypeOf(api, prototype); Object.defineProperty(api, "getCommands", apiDescriptor); Object.defineProperty(ports, "getCommands", portDescriptor); Object.defineProperty(ports, "captureCommandProvider", captureDescriptor); }
  assert.throws(proof.assertCallable, /command provider callable/); assert.throws(originalCapture, /command provider callable/); assert.equal(calls, 0);
  assert.deepEqual(ports.getCommands(), []); assert.equal(calls, 1, "Ordinary dynamic ports are not adopted into the private capture policy");
});

for (const kind of ["copy", "prototype", "proxy", "getters", "foreign-api", "foreign-ports", "proxy-ports"] as const)
test(`Original Pi command provider native reader rejects intrinsic peers before probes without revoking genuine owner (${kind})`, () => {
  let calls = 0, gets = 0;
  const api = { getCommands() { calls++; return []; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0], ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!();
  let value: unknown = proof, receiver = ports;
  if (kind === "copy") value = { ...proof };
  if (kind === "prototype") value = Object.create(proof);
  if (kind === "proxy") value = new Proxy(proof, { get() { gets++; throw Error("No provider proxy get"); }, has() { gets++; throw Error("No provider proxy has"); }, getPrototypeOf() { gets++; throw Error("No provider proxy prototype"); } });
  if (kind === "getters") value = Object.defineProperties({}, { getCommands: { get() { gets++; throw Error("No getter"); } }, assertCallable: { get() { gets++; throw Error("No guard getter"); } } });
  if (kind === "foreign-api") { receiver = createExtensionApiRuntimePorts({ getCommands: api.getCommands } as typeof api, true); }
  if (kind === "foreign-ports") receiver = { ...ports };
  if (kind === "proxy-ports") receiver = new Proxy(ports, { get() { gets++; throw Error("No ports proxy probe"); } });
  assert.equal(Pi.readPiCommandProviderCapture(value, receiver), undefined); assert.equal(gets, 0); assert.equal(calls, 0);
  assert.equal(Pi.readPiCommandProviderCapture(proof, ports), proof); proof.assertCallable(); assert.deepEqual(proof.getCommands(), []); assert.equal(calls, 1);
});

for (const value of [false, 0, "true", {}, true])
test(`Original Pi command provider rejects invalid policy or missing callable (${JSON.stringify(value)})`, () => {
  assert.throws(() => createExtensionApiRuntimePorts({} as never, value as never), /Original Pi command provider requires/);
});

for (const kind of ["accessor", "inherited", "proxy", "function-proxy"] as const)
test(`Original Pi command provider construction requires original own-data API without probes (${kind})`, () => {
  let gets = 0;
  const source = { getCommands() { gets++; return []; } };
  const api = kind === "accessor" ? Object.defineProperty({}, "getCommands", { get() { gets++; return source.getCommands; } }) : kind === "inherited" ? Object.create(source) : kind === "function-proxy" ? { getCommands: new Proxy(source.getCommands, { apply() { gets++; throw Error("No callable proxy"); } }) } : new Proxy(source, { get() { gets++; throw Error("No proxy get"); }, getOwnPropertyDescriptor() { gets++; throw Error("No proxy descriptor"); }, getPrototypeOf() { gets++; throw Error("No proxy prototype"); } });
  assert.throws(() => createExtensionApiRuntimePorts(api, true), /Original Pi command provider requires/); assert.equal(gets, 0);
});

for (const boundary of ["method", "getter", "port", "capture"] as const)
test(`Original Pi command provider final callback barrier withholds returned data after native slot loss (${boundary})`, () => {
  let gets = 0, calls = 0; const list: Pi.PiSlashCommandInfo[] = [];
  const api = { getCommands() {
    calls++;
    if (boundary === "method") api.getCommands = () => list;
    if (boundary === "getter") Object.defineProperty(api, "getCommands", { configurable: true, get() { gets++; return () => list; } });
    if (boundary === "port") ports.getCommands = () => list;
    if (boundary === "capture") ports.captureCommandProvider = () => proof;
    return list;
  } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!();
  assert.throws(proof.getCommands, /command provider callable/); assert.equal(calls, 1); assert.equal(gets, 0);
  assert.throws(proof.assertCallable, /command provider callable/); assert.throws(proof.getCommands, /command provider callable/); assert.equal(calls, 1);
});

for (const reentry of ["read", "capture", "guard", "invoke"] as const)
test(`Original Pi command provider caught native reentry poisons the outer synchronous observation (${reentry})`, () => {
  let calls = 0;
  const api = { getCommands() {
    calls++;
    try {
      if (reentry === "read") Pi.readPiCommandProviderCapture(proof, ports);
      if (reentry === "capture") ports.captureCommandProvider!();
      if (reentry === "guard") proof.assertCallable();
      if (reentry === "invoke") proof.getCommands();
    } catch {}
    return [];
  } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!();
  assert.throws(proof.getCommands, /command provider callable/); assert.equal(calls, 1); assert.throws(proof.assertCallable, /command provider callable/);
});

for (const kind of ["error", "object", "thenable"] as const)
test(`Original Pi command provider refuses unknown callback outcomes without renewal or late getter probes (${kind})`, () => {
  let gets = 0, calls = 0; const cause = new Error("SDK API instance ended");
  const api = { getCommands() { calls++; if (kind === "error") throw cause; return kind === "thenable" ? Object.defineProperty({}, "then", { get() { gets++; throw Error("No thenable probe"); } }) : {}; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!();
  if (kind === "error") assert.throws(proof.getCommands, error => error === cause); else assert.throws(proof.getCommands, /command provider callable/);
  assert.equal(gets, 0); assert.equal(calls, 1); assert.throws(proof.getCommands, /command provider callable/); assert.equal(calls, 1);
});

test("Original Pi command provider pins intrinsic reader and rejects constructor substitution", () => {
  const api = { getCommands() { return []; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0], ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!();
  const ctor = Object.getPrototypeOf(proof).constructor as { new(...args: unknown[]): unknown; read: (...args: unknown[]) => unknown }, read = ctor.read;
  try {
    assert.throws(() => new ctor(Symbol(), api, api.getCommands, ports, ports.getCommands, ports.captureCommandProvider), /command provider callable/);
    ctor.read = () => Object.freeze({ ...proof }); assert.equal(Pi.readPiCommandProviderCapture(proof, ports), proof); assert.equal(ports.captureCommandProvider!(), proof);
  } finally { ctor.read = read; }
});

test("Original Pi command provider callable proof is not inner catalog or result ownership", () => {
  const first: Pi.PiSlashCommandInfo[] = [{ name: "template", source: "prompt", sourceInfo: { path: "/fixture/template.md" } as never }], second = structuredClone(first);
  let inner = () => first;
  const api = { getCommands() { return inner(); } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0], ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!();
  assert.equal(proof.getCommands(), first); inner = () => second; assert.equal(proof.getCommands(), second); assert.deepEqual(first, second); proof.assertCallable();
  assert.equal(ports.captureCommandProvider!(), proof); assert.equal(Object.isFrozen(proof), true);
});

for (const kind of ["accessor", "inherited", "replacement"] as const)
test(`Original Pi command provider omission preserves trusted dynamic/getter semantics (${kind})`, () => {
  let gets = 0, calls = 0, receiver: unknown;
  const original = function(this: unknown) { calls++; receiver = this; return []; };
  const api = (kind === "accessor" ? Object.defineProperty({}, "getCommands", { configurable: true, get() { gets++; return original; } }) : kind === "inherited" ? Object.create({ getCommands: original }) : { getCommands: original }) as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const ports = createExtensionApiRuntimePorts(api); assert.equal(ports.captureCommandProvider, undefined); assert.equal(Object.hasOwn(ports, "captureCommandProvider"), false); assert.equal(gets, 0);
  if (kind === "replacement") api.getCommands = original.bind(api);
  assert.deepEqual(ports.getCommands(), []); assert.equal(receiver, api); assert.equal(calls, 1); assert.equal(gets, kind === "accessor" ? 1 : 0);
});

for (const mode of ["released", "observed-loss", "retained-capture"] as const)
test(`Original Pi command provider lifetimes collect without a parallel provider registry (${mode})`, async () => {
  const api = { getCommands() { return []; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0], ordinary = createExtensionApiRuntimePorts(api);
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  const state = await (async () => {
    const ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!(); proof.assertCallable();
    if (mode === "observed-loss") { api.getCommands = () => []; assert.throws(proof.assertCallable, /command provider callable/); }
    return { weakPorts: new WeakRef(ports), weakProof: new WeakRef(proof), retained: mode === "retained-capture" ? proof : undefined };
  })();
  try {
    if (gc) {
      if (state.retained) {
        await new Promise(resolve => setImmediate(resolve)); gc(); await new Promise(resolve => setImmediate(resolve)); assert.ok(state.weakPorts.deref()); state.retained.assertCallable();
      }
      state.retained = undefined; let collected = false;
      for (let i = 0; i < 60; i++) { await new Promise(resolve => setImmediate(resolve)); gc(); await new Promise(resolve => setImmediate(resolve)); if (state.weakProof.deref() === undefined && state.weakPorts.deref() === undefined) { collected = true; break; } }
      assert.ok(collected); assert.deepEqual(ordinary.getCommands(), []);
      console.log(JSON.stringify({ kind: "pi-command-provider-gc", mode, portsCollected: true, captureCollected: true, ordinaryApiStillOwned: true }));
    }
    assert.deepEqual(ordinary.getCommands(), []);
  } finally { state.retained = undefined; }
});

test("Original Pi command provider invocation does not consult the callable call property", () => {
  let gets = 0, receiver: unknown;
  const api = { getCommands() { receiver = this; return []; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  Object.defineProperty(api.getCommands, "call", { get() { gets++; throw Error("No callable call getter"); } });
  const ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!();
  let answer: unknown, failure: unknown; try { answer = proof.getCommands(); } catch (error) { failure = error; }
  assert.equal(failure, undefined); assert.deepEqual(answer, []); assert.equal(gets, 0); assert.equal(receiver, api);
});

test("Original Pi command provider construction and final-use barrier pin intrinsic data operations", () => {
  const own = Object.getOwnPropertyDescriptor, apply = Reflect.apply, array = Array.isArray; let gets = 0, answer: unknown, capture: unknown, failure: unknown;
  const api = { getCommands() {
    Object.getOwnPropertyDescriptor = (() => { gets++; throw Error("No late descriptor callback"); }) as typeof own;
    Array.isArray = (() => { gets++; throw Error("No late Array callback"); }) as unknown as typeof array;
    Reflect.apply = (() => { gets++; throw Error("No late apply callback"); }) as typeof apply;
    return [];
  } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  try {
    Object.getOwnPropertyDescriptor = (() => { gets++; throw Error("No constructor descriptor callback"); }) as typeof own;
    const ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!(); capture = proof;
    answer = proof.getCommands(); proof.assertCallable();
  } catch (error) { failure = error; } finally { Object.getOwnPropertyDescriptor = own; Reflect.apply = apply; Array.isArray = array; }
  assert.equal(failure, undefined); assert.ok(capture); assert.deepEqual(answer, []); assert.equal(gets, 0);
});

test("Original Pi command provider passive callable facts do not invent hidden SDK activity", () => {
  let active = true; const ended = new Error("Original SDK API ended");
  const api = { getCommands() { if (!active) throw ended; return []; } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const ports = createExtensionApiRuntimePorts(api, true), proof = ports.captureCommandProvider!(); active = false;
  assert.equal(proof.assertCallable(), undefined); assert.equal(ports.captureCommandProvider!(), proof);
  assert.throws(proof.getCommands, error => error === ended); active = true; assert.throws(proof.assertCallable, /command provider callable/);
});

for (const phase of ["construction", "after-callback"] as const)
test(`Original Pi command provider accessor descriptor never reads an inherited value getter (${phase})`, () => {
  let gets = 0, cause: unknown;
  const accessor = Object.assign(Object.create(null), { configurable: true, get() { gets++; return () => []; } });
  const pollution = Object.assign(Object.create(null), { configurable: true, get() { gets++; throw Error("No descriptor prototype getter"); } });
  const api = { getCommands() {
    Object.defineProperty(api, "getCommands", accessor);
    Object.defineProperty(Object.prototype, "value", pollution);
    return [];
  } } as unknown as Parameters<typeof createExtensionApiRuntimePorts>[0];
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  if (phase === "construction") Object.defineProperty(api, "getCommands", accessor);
  try {
    if (phase === "construction") Object.defineProperty(Object.prototype, "value", pollution);
    const ports = createExtensionApiRuntimePorts(api, true);
    ports.captureCommandProvider!().getCommands();
  } catch (error) { cause = error; }
  finally {
    delete (Object.prototype as Record<string, unknown>).value;
    if (previous) Object.defineProperty(Object.prototype, "value", previous);
  }
  assert.equal(gets, 0);
  assert.match(String(cause), phase === "construction" ? /Original Pi command provider requires/ : /command provider callable/);
});

test("Pi context mode helpers feature-detect passive run modes", () => {
  assert.equal(getExtensionContextMode({ mode: "print" }), "print");
  assert.equal(getExtensionContextMode({ mode: "bogus" }), undefined);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "print" }), true);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "json" }), true);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "rpc" }), false);
  assert.equal(isExtensionContextPassiveRunMode({}), false);
  assert.equal(canStartPollingInExtensionContext({ mode: "tui" }), true);
  assert.equal(canStartPollingInExtensionContext({ mode: "rpc" }), true);
  assert.equal(canStartPollingInExtensionContext({ mode: "json" }), false);
  assert.equal(canStartPollingInExtensionContext({ mode: "print" }), false);
  assert.equal(canStartPollingInExtensionContext({}), true);
  assert.equal(
    formatPollingStartBlockedByRunMode({ mode: "json" }),
    "Telegram polling is unavailable in Pi json mode. Use /telegram-connect from a long-lived Pi session.",
  );
});

test("Pi abort adapter reads the current public signal without inventing one", () => {
  const abort = new AbortController();
  const ctx = { signal: abort.signal } as ExtensionContext;
  assert.equal(isExtensionContextAbortRequested(ctx), false);
  abort.abort();
  assert.equal(isExtensionContextAbortRequested(ctx), true);
  assert.equal(isExtensionContextAbortRequested({} as ExtensionContext), false);
});

test("Pi session identity adapter is lifecycle-alias agnostic", () => {
  assert.equal(getExtensionContextSessionId(undefined), undefined, "Missing context cannot invent a session identity");
  const sessionManager = { getSessionId: () => "stable-session" };
  for (const lifecycleAlias of ["restart", "reload", "resume", "continue-recent"]) {
    const ctx = { sessionManager, lifecycleAlias } as unknown as ExtensionContext;
    assert.equal(getExtensionContextSessionId(ctx), "stable-session");
  }
  const forked = { sessionManager: { getSessionId: () => "forked-session" } } as ExtensionContext;
  assert.notEqual(getExtensionContextSessionId(forked), "stable-session");
});

test("Pi API runtime ports bind methods without losing receiver context", async () => {
  const api: PiRuntimeApiHarness = {
    events: [],
    sendUserMessage(content, options) {
      this.events.push(
        `send:${String(content)}:${options?.deliverAs ?? "default"}`,
      );
    },
    async exec(command, args) {
      this.events.push(`exec:${command}:${args.join(",")}`);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    getCommands() {
      this.events.push("commands");
      return [];
    },
    getThinkingLevel() {
      this.events.push("get-thinking");
      return "high";
    },
    setThinkingLevel(level) {
      this.events.push(`thinking:${String(level)}`);
    },
    getActiveTools() {
      this.events.push("get-tools");
      return ["read"];
    },
    setActiveTools(names) {
      this.events.push(`set-tools:${names.join(",")}`);
    },
    async setModel(model) {
      this.events.push(`model:${getHarnessModelId(model)}`);
      return true;
    },
    registerCommand(name) {
      this.events.push(`command:${name}`);
    },
  };
  const runtime = createExtensionApiRuntimePorts(api);
  runtime.sendUserMessage("hello", { deliverAs: "followUp" });
  assert.deepEqual(await runtime.exec("cmd", ["arg"]), {
    stdout: "ok",
    stderr: "",
    code: 0,
    killed: false,
  });
  assert.deepEqual(runtime.getCommands(), []);
  assert.equal(runtime.getThinkingLevel(), "high");
  runtime.setThinkingLevel("low");
  assert.deepEqual(runtime.getActiveTools(), ["read"]);
  runtime.setActiveTools(["read", "telegram_attach"]);
  assert.equal(await runtime.setModel(createHarnessModel("gpt-5")), true);
  runtime.registerCommand("telegram-connect", {
    description: "internal",
    handler: async () => {},
  });
  assert.deepEqual(api.events, [
    "send:hello:followUp",
    "exec:cmd:arg",
    "commands",
    "get-thinking",
    "thinking:low",
    "get-tools",
    "set-tools:read,telegram_attach",
    "model:gpt-5",
    "command:telegram-connect",
  ]);
});

for (const source of [true, false])
test(`Pi cold Root imports defer the settings SDK until first use (${source ? "source" : "compiled"})`, { timeout: 25000 }, async () => {
  const result = await runNodeEval(`
    import assert from "node:assert/strict";
    import { register } from "node:module";
    register("data:text/javascript," + encodeURIComponent(\`
      export function resolve(specifier, context, nextResolve) {
        if (specifier === "@earendil-works/pi-coding-agent")
          throw new Error("Settings SDK import refused by original cold-import probe");
        return nextResolve(specifier, context);
      }
    \`), import.meta.url);
    const base = ${JSON.stringify(source ? "./lib/" : "./dist/lib/")}, suffix = ${JSON.stringify(source ? ".ts" : ".js")};
    const Pi = await import(base + "pi" + suffix);
    assert.equal(Pi.isPiStaleContextError(new Error("stale ctx")), true);
    for (const name of ["outbound", "bindings", "extension"]) await import(base + name + suffix);
    console.log("pi-cold-root-import-ready");
    await assert.rejects(Pi.createSettingsManager("unused-cold-probe"), /Settings SDK import refused by original cold-import probe/);
    console.log("pi-lazy-settings-boundary-pass");
  `, { timeoutMs: 12000, readiness: { stdoutPrefix: "pi-cold-root-import-ready", startupTimeoutMs: 10000 } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /pi-lazy-settings-boundary-pass/);
});

test("Pi settings first use retains the installed SDK and source/compiled persistence", { timeout: 25000 }, async () => {
  const result = await runNodeEval(`
    import assert from "node:assert/strict";
    import { mkdtemp, mkdir, rm } from "node:fs/promises";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    const dir = await mkdtemp(join(tmpdir(), "pt-pi-settings-"));
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    await mkdir(process.env.PI_CODING_AGENT_DIR);
    try {
      const adapters = [await import("./lib/pi.ts"), await import("./dist/lib/pi.js")];
      const first = await adapters[0].createSettingsManager(dir);
      console.log("pi-settings-sdk-ready");
      first.setEnabledModels(["openai/original-settings-probe"]);
      await first.flush();
      const second = await adapters[1].createSettingsManager(dir);
      await second.reload();
      assert.deepEqual(second.getEnabledModels(), ["openai/original-settings-probe"]);
      second.setEnabledModels(["openai/compiled-settings-probe"]);
      await second.flush();
      await first.reload();
      assert.deepEqual(first.getEnabledModels(), ["openai/compiled-settings-probe"]);
      console.log("pi-native-settings-persistence-pass");
    } finally { await rm(dir, { recursive: true, force: true }); }
  `, { timeoutMs: 12000, readiness: { stdoutPrefix: "pi-settings-sdk-ready", startupTimeoutMs: 10000 } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /pi-native-settings-persistence-pass/);
});

test("Managed compiled entrypoint supplies loader-mapped settings without local host peers", { timeout: 30000 }, async () => {
  const result = await runNodeEval(`
    import assert from "node:assert/strict";
    import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
    import { createRequire } from "node:module";
    import { join } from "node:path";
    import { pathToFileURL, fileURLToPath } from "node:url";
    import { tmpdir } from "node:os";
    const host = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { createJiti } = await import(pathToFileURL(createRequire(host).resolve("jiti")).href);
    const dir = await mkdtemp(join(tmpdir(), "pt-managed-settings-"));
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    await mkdir(process.env.PI_CODING_AGENT_DIR);
    try {
      const root = join(dir, "package");
      await cp("./dist", root, { recursive: true });
      const adapter = await import(pathToFileURL(join(root, "lib/pi.js")).href);
      await assert.rejects(adapter.createSettingsManager(dir), { code: "ERR_MODULE_NOT_FOUND" });
      // Isolate the bootstrap port, not a second runtime: actual entrypoint, SDK boundary and adapter stay intact.
      await writeFile(join(root, "lib/extension.js"), "export default (pi, settings) => { pi.settings = settings; };\\n");
      const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
        "@earendil-works/pi-coding-agent": fileURLToPath(host),
        "@sinclair/typebox": fileURLToPath(import.meta.resolve("@sinclair/typebox")),
      } });
      const extension = await jiti.import(join(root, "pi-telegram/index.js"), { default: true });
      const ports = {};
      extension(ports);
      assert.equal(typeof ports.settings, "function", "The installed entrypoint must supply the host factory");
      console.log("pi-managed-settings-ready");
      const first = await ports.settings(dir);
      first.setEnabledModels(["openai/managed-settings-probe"]);
      await first.flush();
      const second = await ports.settings(dir);
      await second.reload();
      assert.deepEqual(second.getEnabledModels(), ["openai/managed-settings-probe"]);
      second.setEnabledModels(undefined);
      await second.flush();
      await first.reload();
      assert.equal(first.getEnabledModels(), undefined);
      console.log("pi-managed-settings-persistence-pass");
    } finally { await rm(dir, { recursive: true, force: true }); }
  `, { timeoutMs: 12000, readiness: { stdoutPrefix: "pi-managed-settings-ready", startupTimeoutMs: 15000 } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /pi-managed-settings-persistence-pass/);
});

test("Pi settings adapter preserves legacy and generic host capabilities", async () => {
  const legacyEvents: string[] = [];
  const legacy = normalizeSettingsManager({
    reload: async () => legacyEvents.push("reload"),
    flush: async () => legacyEvents.push("flush"),
    getEnabledModels: () => ["openai/gpt-5"],
    setEnabledModels: (patterns: string[] | undefined) =>
      legacyEvents.push(`set:${patterns?.join(",") ?? "all"}`),
  });
  await legacy.reload();
  assert.deepEqual(legacy.getEnabledModels(), ["openai/gpt-5"]);
  legacy.setEnabledModels(undefined);
  await legacy.flush();
  assert.deepEqual(legacyEvents, ["reload", "set:all", "flush"]);

  const genericEvents: string[] = [];
  let enabledModels = ["anthropic/claude-sonnet-4"];
  const generic = normalizeSettingsManager({
    get: (key: string) => {
      genericEvents.push(`get:${key}`);
      return enabledModels;
    },
    set: (key: string, value: unknown) => {
      genericEvents.push(`set:${key}:${JSON.stringify(value)}`);
      enabledModels = value as string[];
    },
    flush: async () => genericEvents.push("flush"),
  });
  await generic.reload();
  assert.deepEqual(generic.getEnabledModels(), ["anthropic/claude-sonnet-4"]);
  generic.setEnabledModels(undefined);
  await generic.flush();
  assert.deepEqual(genericEvents, [
    "get:enabledModels",
    "set:enabledModels:[]",
    "flush",
  ]);
});

test("Pi scoped model persister invalidates cached inputs without clearing live menus", async () => {
  const events: string[] = [];
  const persist = createScopedModelPatternPersister({
    createSettingsManager: async (cwd) => ({
      reload: async () => {},
      flush: async () => {
        events.push("flush");
      },
      getEnabledModels: () => undefined,
      setEnabledModels: (patterns) => {
        events.push(`set:${cwd}:${patterns?.join(",") ?? "all"}`);
      },
    }),
    clearCachedModelMenuInputs: () => {
      events.push("clear-cache");
    },
  });
  await persist(["openai/gpt-5"], { cwd: "/tmp/project" } as ExtensionContext);
  assert.deepEqual(events, [
    "set:/tmp/project:openai/gpt-5",
    "flush",
    "clear-cache",
  ]);
});

test("Pi context helpers expose model, idle, pending-message, and compact adapters", () => {
  const model = { provider: "openai", id: "gpt-5", name: "GPT-5" };
  const events: string[] = [];
  const ctx = {
    model,
    isIdle: () => true,
    hasPendingMessages: () => false,
    cwd: "/tmp/project",
    compact: (callbacks: { onComplete: () => void }) => {
      events.push("compact");
      callbacks.onComplete();
    },
  } as unknown as ExtensionContext;
  compactExtensionContext(ctx, {
    onComplete: () => {
      events.push("complete");
    },
    onError: () => {
      events.push("error");
    },
  });
  assert.equal(getExtensionContextModel(ctx), model);
  assert.equal(getExtensionContextCwd(ctx), "/tmp/project");
  assert.equal(isExtensionContextIdle(ctx), true);
  assert.equal(hasExtensionContextPendingMessages(ctx), false);
  assert.deepEqual(events, ["compact", "complete"]);
});
