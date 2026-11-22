/**
 * Generative App runtime regression tests
 * Covers canonical identity, installation, invocation, state transactions, recovery, bounded processes, and Tool registration
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile, appendFile, rename } from "node:fs/promises";
import nativeFileSystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { setImmediate as nextWorkerTurn, setTimeout as callbackWorkerWindow } from "node:timers/promises";


import {
  bindGenerativeApp,
  getGenerativeAppCallbackBinding,
  getGenerativeAppRefreshPublicationSource,
  captureGenerativeAppCallbackOwner,
  createGenerativeAppLiveSurfaceRuntime,
  GENERATIVE_APP_MAX_REFRESH_AFTER_MS,
  GENERATIVE_APP_MIN_REFRESH_AFTER_MS,
  formatDisplayedGenerativeAppToolOutput,
  formatGenerativeAppToolError,
  formatGenerativeAppToolOutput,
  installGenerativeApp,
  invokeGenerativeApp,
  parseGenerativeAppBoundAction,
  registerTelegramBindTool,
  resolveGenerativeAppDir,
  resolveGenerativeAppModulePath,
} from "../lib/generative-apps.ts";
import {
  bindTelegramDeliveryRuntime,
  createTelegramBridgeDeliveryRuntime,
  createTelegramDeliveryTargetPolicyRuntime,
  editTelegramView,
  isTelegramDeliveryHandleCurrent,
  sendTelegramView,
} from "../lib/delivery.ts";
import type { ExtensionAPI } from "../lib/pi.ts";
import { createTelegramButtonActionStore, planTelegramButtonReply } from "../lib/outbound-buttons.ts";
import { createTelegramBusAwareApiRuntime, createTelegramButtonPublicationEditor } from "../lib/bus-api.ts";
import type { TelegramBridgeApiRuntime } from "../lib/telegram-api.ts";
import type { TelegramInlineKeyboardMarkup } from "../lib/keyboard.ts";
import { createTelegramOutboundReplyPlanner, type TelegramOutboundButtonAction } from "../lib/outbound.ts";

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
export function scheduled({ argument }) {
  return { output: "scheduled", refreshAfterMs: argument };
}
export function refresh({ state, argument }) {
  return argument === "stateful"
    ? { output: "invalid refresh", state }
    : { output: "refreshed", refreshAfterMs: argument };
}
`;


const callbackWorkerApp = statefulApp + '\nexport function fail(){throw Error("native failure")} export async function hold(){await new Promise(()=>{})}';

async function readOnlySuccessorFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-readonly-successor-")), agentDir = join(root, "agent");
  const script = await writeApp(root, "counter", callbackWorkerApp);
  const result = await installGenerativeApp({ agentDir, app: "counter", script }), binding = getGenerativeAppCallbackBinding(result), owner = captureGenerativeAppCallbackOwner(binding)!;
  assert.equal(typeof owner.captureReadOnlySuccessor, "function");
  return { root, agentDir, script, binding, owner, invoke: () => invokeGenerativeApp({ agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true, callbackBinding: binding }), close: () => rm(root, { recursive: true, force: true }) };
}
test("Private read-only successor records exact native non-transitive predecessor", async () => {
  const h = await readOnlySuccessorFixture();
  try {
    const b = getGenerativeAppCallbackBinding(await h.invoke()), bo = captureGenerativeAppCallbackOwner(b)!;
    assert.notEqual(b, h.binding); assert.equal(b.generation, h.binding.generation); assert.equal(b.revision, h.binding.revision);
    assert.equal(h.owner.captureReadOnlySuccessor!(b), bo); assert.equal(h.owner.captureReadOnlySuccessor!(b), bo);
    const c = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true, callbackBinding: b }));
    assert.equal(bo.captureReadOnlySuccessor!(c), captureGenerativeAppCallbackOwner(c)); assert.equal(h.owner.captureReadOnlySuccessor!(c), undefined);
    assert.equal(bo.captureReadOnlySuccessor!(b), undefined); assert.equal(h.owner.captureReadOnlySuccessor!(h.binding), undefined);
  } finally { await h.close(); }
});
test("Private read-only successor refuses equal-field peers and default unowned completion", async () => {
  const h = await readOnlySuccessorFixture();
  try {
    const peer = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true }));
    const peerOwner = captureGenerativeAppCallbackOwner(peer)!;
    assert.equal(h.owner.captureReadOnlySuccessor!(peer), undefined);
    const b = getGenerativeAppCallbackBinding(await h.invoke()); assert.equal(peerOwner.captureReadOnlySuccessor!(b), undefined);
    const legacy = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect", get callbackBinding() { return assert.fail("Omitted drain must not read origin"); } }));
    assert.equal(h.owner.captureReadOnlySuccessor!(legacy), undefined);
  } finally { await h.close(); }
});
for (const kind of ["copy", "proxy", "prototype", "foreign", "async", "null"] as const)
test(`Private read-only successor rejects nonnative origin without argument or foreign getter probes (${kind})`, async () => {
  const h = await readOnlySuccessorFixture(); let probes = 0;
  try {
    const foreign = Object.defineProperty({}, "app", { get() { probes++; throw Error("Foreign getter"); } });
    const value = kind === "copy" ? { ...h.binding } : kind === "proxy" ? new Proxy(h.binding, {}) : kind === "prototype" ? Object.create(h.binding) : kind === "async" ? Promise.resolve(h.binding) : kind === "null" ? null : foreign;
    await assert.rejects(invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true, callbackBinding: value, get argument() { probes++; return null; } }), /callback origin is unavailable/u);
    assert.equal(h.owner.captureReadOnlySuccessor!(value), undefined); assert.equal(probes, 0);
  } finally { await h.close(); }
});
for (const boundary of ["directory", "generation", "revision"] as const)
test(`Private read-only successor binds original app path and explicit expectations (${boundary})`, async () => {
  const h = await readOnlySuccessorFixture(); let other: Awaited<ReturnType<typeof readOnlySuccessorFixture>> | undefined;
  try {
    if (boundary === "directory") other = await readOnlySuccessorFixture();
    await assert.rejects(invokeGenerativeApp({ agentDir: other?.agentDir ?? h.agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true, callbackBinding: h.binding,
      ...(boundary === "generation" ? { expectedGeneration: "foreign" } : boundary === "revision" ? { expectedRevision: h.binding.revision + 1 } : {}) }), /callback origin is unavailable/u);
  } finally { await other?.close(); await h.close(); }
});
for (const phase of ["before", "argument", "observation", "before-worker", "after-drain"] as const)
test(`Private read-only successor never renews lost original history (${phase})`, async t => {
  const h = await readOnlySuccessorFixture(), journal = join(h.agentDir, "genapps", "counter", "states.jsonl"), bytes = await readFile(journal);
  let lost = false, checks = 0, workers = 0;
  const terminate = Worker.prototype.terminate;
  t.mock.method(Worker.prototype, "terminate", function(this: Worker) { workers++; return Reflect.apply(terminate, this, []); });
  const lose = () => { if (lost) return; lost = true; nativeFileSystem.appendFileSync(journal, "\n"); assert.throws(h.owner.assertCurrent); nativeFileSystem.writeFileSync(journal, bytes); };
  try {
    if (phase === "before") lose();
    await assert.rejects(invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true, callbackBinding: h.binding,
      get argument() { if (phase === "argument") lose(); return null; },
      onOwnerObserved() { if (phase === "observation") lose(); },
      execution: { signal: new AbortController().signal, assertCurrent() { checks++; if (phase === "before-worker" && checks === 2 || phase === "after-drain" && checks === 3) lose(); } } }), /callback owner is unavailable/u);
    assert.equal(lost, true); assert.equal(workers, phase === "after-drain" ? 1 : 0); assert.equal(captureGenerativeAppCallbackOwner(h.binding), undefined);
  } finally { t.mock.restoreAll(); await h.close(); }
});
test("Private read-only successor uses native facts rather than mutable public result fields", async () => {
  const h = await readOnlySuccessorFixture();
  try {
    const r = await h.invoke(), b = getGenerativeAppCallbackBinding(r); r.stateChanged = true; r.app = "foreign"; r.generation = "foreign"; r.revision = 999;
    assert.equal(h.owner.captureReadOnlySuccessor!(b), captureGenerativeAppCallbackOwner(b));
    const changed = await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "increment", callbackWorkerDrain: true, callbackBinding: b });
    changed.stateChanged = false; assert.equal(captureGenerativeAppCallbackOwner(b), undefined);
    assert.equal(h.owner.captureReadOnlySuccessor!(getGenerativeAppCallbackBinding(changed)), undefined);
  } finally { await h.close(); }
});
test("Private read-only successor pins origin once before argument getters", async () => {
  const h = await readOnlySuccessorFixture(); let reads = 0;
  try {
    const peer = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect" }));
    const b = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true,
      get callbackBinding() { reads++; return reads === 1 ? h.binding : peer; }, get argument() { assert.equal(reads, 1); return null; } }));
    assert.equal(reads, 1); assert.equal(h.owner.captureReadOnlySuccessor!(b), captureGenerativeAppCallbackOwner(b));
    assert.equal(captureGenerativeAppCallbackOwner(peer)!.captureReadOnlySuccessor!(b), undefined);
  } finally { await h.close(); }
});
test("Private read-only successor keeps both original and child data histories after native I/O", async t => {
  const h = await readOnlySuccessorFixture(), journal = join(h.agentDir, "genapps", "counter", "states.jsonl"), bytes = await readFile(journal);
  try {
    const b = getGenerativeAppCallbackBinding(await h.invoke()), bo = captureGenerativeAppCallbackOwner(b)!; let calls = 0;
    const stat = nativeFileSystem.lstatSync;
    t.mock.method(nativeFileSystem, "lstatSync", (...args: unknown[]) => { const result = Reflect.apply(stat, nativeFileSystem, args);
      if (String(args[0]).endsWith("states.jsonl") && ++calls === 2) { nativeFileSystem.appendFileSync(journal, "\n"); assert.throws(h.owner.assertCurrent); nativeFileSystem.writeFileSync(journal, bytes); } return result;
    }); syncBuiltinESMExports();
    assert.equal(h.owner.captureReadOnlySuccessor!(b), undefined); assert.throws(h.owner.assertObservedCurrent); bo.assertObservedCurrent();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.close(); }
});
test("Private read-only successor refuses child own-history loss during native I/O", async t => {
  const h = await readOnlySuccessorFixture();
  try {
    const b = getGenerativeAppCallbackBinding(await h.invoke()), bo = captureGenerativeAppCallbackOwner(b)!; let calls = 0;
    const stat = nativeFileSystem.lstatSync;
    t.mock.method(nativeFileSystem, "lstatSync", (...args: unknown[]) => { const result = Reflect.apply(stat, nativeFileSystem, args);
      if (String(args[0]).endsWith("states.jsonl") && ++calls === 2) assert.throws(bo.assertObservedCurrent); return result;
    }); syncBuiltinESMExports();
    assert.equal(h.owner.captureReadOnlySuccessor!(b), undefined); assert.throws(bo.assertObservedCurrent); h.owner.assertObservedCurrent();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.close(); }
});
test("Private read-only successor pins the native source reader and weak history reader", async t => {
  const h = await readOnlySuccessorFixture();
  try {
    const peer = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect" })), po = captureGenerativeAppCallbackOwner(peer)!;
    const ctor = Object.getPrototypeOf(h.binding).constructor;
    t.mock.method(ctor, "source", () => ({ appDir: "", owner: po, predecessor: po }));
    t.mock.method(WeakRef.prototype, "deref", () => po);
    const result = await h.invoke().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    assert.equal(result.ok, true, "Mutable reader slots cannot substitute a native original"); if (!result.ok) return;
    const b = getGenerativeAppCallbackBinding(result.value);
    assert.equal(h.owner.captureReadOnlySuccessor!(b), captureGenerativeAppCallbackOwner(b)); assert.equal(po.captureReadOnlySuccessor!(b), undefined);
  } finally { t.mock.restoreAll(); await h.close(); }
});


test("Private read-only successor pins the native weak constructor without strong ancestry", async () => {
  const h = await readOnlySuccessorFixture(), descriptor = Object.getOwnPropertyDescriptor(globalThis, "WeakRef")!;
  try {
    Object.defineProperty(globalThis, "WeakRef", { ...descriptor, value: class { constructor() { assert.fail("No mutable weak constructor"); } } });
    const b = getGenerativeAppCallbackBinding(await h.invoke());
    assert.equal(h.owner.captureReadOnlySuccessor!(b), captureGenerativeAppCallbackOwner(b));
  } finally { Object.defineProperty(globalThis, "WeakRef", descriptor); await h.close(); }
});


test("Private read-only successor does not misclassify a completed state write", async () => {
  const h = await readOnlySuccessorFixture();
  try {
    const result = await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "increment", callbackWorkerDrain: true, callbackBinding: h.binding }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    assert.equal(result.ok, true, "A state write may complete but cannot acquire read-only predecessor facts");
    if (!result.ok) return;
    assert.equal(result.value.stateChanged, true); assert.equal(result.value.revision, h.binding.revision + 1);
    assert.equal(h.owner.captureReadOnlySuccessor!(getGenerativeAppCallbackBinding(result.value)), undefined);
  } finally { await h.close(); }
});


for (const lastCheck of [3, 4])
test(`Private read-only successor checks original authority before a state commit after drain (${lastCheck})`, async () => {
  const h = await readOnlySuccessorFixture(), journal = join(h.agentDir, "genapps", "counter", "states.jsonl"), bytes = await readFile(journal); let checks = 0;
  try {
    await assert.rejects(invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "increment", callbackWorkerDrain: true, callbackBinding: h.binding,
      execution: { signal: new AbortController().signal, assertCurrent() { if (++checks === lastCheck) { nativeFileSystem.appendFileSync(journal, "\n"); assert.throws(h.owner.assertCurrent); nativeFileSystem.writeFileSync(journal, bytes); } } } }), /callback owner is unavailable/u);
    assert.equal((await readFile(journal)).equals(bytes), true);
    assert.equal((await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect" })).output, '{"count":0}');
  } finally { await h.close(); }
});


test("Private read-only successor rechecks its original after native successor recording I/O", async t => {
  const h = await readOnlySuccessorFixture(), journal = join(h.agentDir, "genapps", "counter", "states.jsonl"), bytes = await readFile(journal), stat = nativeFileSystem.promises.lstat;
  let observed = false;
  try {
    t.mock.method(nativeFileSystem.promises, "lstat", async (...args: unknown[]) => { const result = await Reflect.apply(stat, nativeFileSystem.promises, args);
      if (String(args[0]).endsWith("states.jsonl")) { observed = true; nativeFileSystem.appendFileSync(journal, "\n"); assert.throws(h.owner.assertCurrent); nativeFileSystem.writeFileSync(journal, bytes); } return result;
    }); syncBuiltinESMExports();
    await assert.rejects(h.invoke(), /callback owner is unavailable/u); assert.equal(observed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.close(); }
});


test("Private read-only successor cannot lend execution or callback authority through its origin getter", async () => {
  const h = await readOnlySuccessorFixture(); let lost = false, adopted = 0;
  const options = { agentDir: h.agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true as const,
    execution: { signal: new AbortController().signal, assertCurrent() { if (lost) throw Error("Original source execution lost"); } },
    assertCallbackOwner() { if (lost) throw Error("Original source callback lost"); },
    get callbackBinding() { lost = true; options.execution = { signal: new AbortController().signal, assertCurrent() { adopted++; } }; options.assertCallbackOwner = () => { adopted++; }; return h.binding; } };
  try { await assert.rejects(invokeGenerativeApp(options), /Original source (callback|execution) lost/u); assert.equal(adopted, 0); }
  finally { await h.close(); }
});

for (const scenario of ["success", "failure", "state", "abort", "timeout", "late-abort", "late-source", "callback-loss", "queue", "queue-failure", "term-reject", "term-reject-falsy", "term-throw", "early-term-ack", "exit-before-ack", "pinned", "terminate-pin"] as const)
test(`Private callback worker ownership retains original termination and invocation lane (${scenario})`, { timeout: 8000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-callback-worker-owner-")), agentDir = join(root, "agent"), script = await writeApp(root, "counter", callbackWorkerApp);
  const initial = await installGenerativeApp({ agentDir, app: "counter", script }), binding = getGenerativeAppCallbackBinding(initial);
  const nativeTerminate = Worker.prototype.terminate, entered = Promise.withResolvers<void>(), registered = Promise.withResolvers<void>();
  const controller = new AbortController(), foreign = new AbortController(), gates: { worker: Worker; exit: boolean; release: () => void; work: Promise<number> }[] = [];
  let sourceCurrent = true, settled = false, secondAdmitted = false, foreignChecks = 0, foreignTerminations = 0, reads = 0;
  const originalCheck = binding.assertCurrent;
  const fence = { signal: controller.signal, assertCurrent() { assert.equal(this, fence); if (!sourceCurrent) throw Error("Original callback source lost"); } };
  const listener = controller.signal.addEventListener;
  t.mock.method(controller.signal, "addEventListener", function(this: AbortSignal, ...args: Parameters<AbortSignal["addEventListener"]>) {
    Reflect.apply(listener, this, args); if (args[0] === "abort") registered.resolve();
  });
  t.mock.method(Worker.prototype, "terminate", function(this: Worker) {
    const release = Promise.withResolvers<void>(), worker = this, gate = { worker, exit: false, release: () => release.resolve(), work: Promise.resolve(0) };
    worker.once("exit", () => { gate.exit = true; });
    gate.work = scenario === "term-reject-falsy" ? Promise.reject(undefined) : scenario === "term-reject" ? Promise.reject(Error("Unknown native termination")) :
      ["early-term-ack", "term-throw"].includes(scenario) ? Promise.resolve(0) :
      scenario === "exit-before-ack" ? Reflect.apply(nativeTerminate, worker, []).then(async (code: number) => { await release.promise; return code; }) :
      release.promise.then(() => Reflect.apply(nativeTerminate, worker, []));
    if (["term-reject", "term-reject-falsy", "term-throw", "early-term-ack"].includes(scenario)) { let issued = false; gate.release = () => { if (!issued) { issued = true; release.resolve(); void Reflect.apply(nativeTerminate, worker, []); } }; }
    gates.push(gate); entered.resolve(); if (scenario === "term-throw") throw Error("Unknown synchronous termination"); return gate.work;
  });
  const options = { agentDir, app: "counter", method: ["abort", "timeout"].includes(scenario) ? "hold" : ["failure", "queue-failure"].includes(scenario) ? "fail" : scenario === "state" ? "increment" : "inspect",
    get callbackWorkerDrain(): true { reads++; return true; }, execution: fence, assertCallbackOwner: originalCheck, methodTimeoutMs: scenario === "timeout" ? 50 : 5000 };
  const result = invokeGenerativeApp(options).then(value => { settled = true; return { ok: true as const, value }; }, error => { settled = true; return { ok: false as const, error: String(error.message) }; });
  let second: ReturnType<typeof invokeGenerativeApp> | undefined;
  try {
    if (scenario === "abort") { await registered.promise; controller.abort(); }
    if (scenario === "terminate-pin") { const captured = Worker.prototype.terminate; await registered.promise; Object.defineProperty(Worker.prototype, "terminate", { configurable: true, writable: true, value: function(this: Worker) { foreignTerminations++; return Reflect.apply(captured, this, []); } }); }
    if (scenario === "pinned") { fence.signal = foreign.signal; fence.assertCurrent = () => { foreignChecks++; }; options.execution = { signal: foreign.signal, assertCurrent: () => { foreignChecks++; } }; options.assertCallbackOwner = () => { foreignChecks++; }; }
    await entered.promise; await callbackWorkerWindow(25); assert.equal(reads, 1); assert.equal(gates.length, 1); assert.equal(foreignTerminations, 0); assert.equal(settled, false);
    if (scenario === "exit-before-ack") { while (!gates[0]!.exit) await nextWorkerTurn(); await callbackWorkerWindow(25); assert.equal(settled, false); }
    else { assert.equal(gates[0]!.exit, false); assert.ok(gates[0]!.worker.threadId > 0); }
    if (scenario === "state") assert.equal((await readFile(join(agentDir, "genapps", "counter", "states.jsonl"), "utf8")).trim().split("\n").length, 1);
    if (scenario === "late-abort") controller.abort();
    if (scenario === "late-source") sourceCurrent = false;
    if (scenario === "callback-loss") await appendFile(join(agentDir, "genapps", "counter", "states.jsonl"), "\n");
    if (scenario === "queue" || scenario === "queue-failure") {
      second = invokeGenerativeApp({ agentDir, app: "counter", method: "inspect", callbackWorkerDrain: true, assertCallbackOwner() { secondAdmitted = true; } });
      await nextWorkerTurn(); await nextWorkerTurn(); assert.equal(secondAdmitted, false);
    }
    gates[0]!.release(); await gates[0]!.work.catch(() => undefined);
    const outcome = await result; assert.equal(gates[0]!.exit, true); assert.equal(gates[0]!.worker.threadId, -1);
    assert.equal(outcome.ok, !["failure", "queue-failure", "abort", "timeout", "late-abort", "late-source", "callback-loss", "term-reject", "term-reject-falsy", "term-throw"].includes(scenario));
    assert.equal(foreignChecks, 0);
    if (second) { while (gates.length < 2) await nextWorkerTurn(); assert.equal(secondAdmitted, true); gates[1]!.release(); await second; }
  } finally {
    controller.abort(); for (const gate of gates) gate.release(); await Promise.allSettled([result, ...(second ? [second] : []), ...gates.map(g => g.work)]);
    t.mock.restoreAll(); assert.equal(Worker.prototype.terminate, nativeTerminate); await rm(root, { recursive: true, force: true });
  }
});
for (const method of ["inspect", "fail"])
test(`Private callback worker ownership preserves omitted result-before-drain behavior (${method})`, { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-callback-worker-owner-")), agentDir = join(root, "agent"), script = await writeApp(root, "counter", callbackWorkerApp);
  await installGenerativeApp({ agentDir, app: "counter", script }); const original = Worker.prototype.terminate, release = Promise.withResolvers<void>(), exits: Worker[] = [], drains: Promise<number>[] = [];
  t.mock.method(Worker.prototype, "terminate", function(this: Worker) { exits.push(this); const work = release.promise.then(() => Reflect.apply(original, this, [])); drains.push(work); return work; });
  try {
    const result = await invokeGenerativeApp({ agentDir, app: "counter", method }).then(() => true, () => false);
    assert.equal(result, method === "inspect"); assert.equal(exits.length, 1); assert.ok(exits[0]!.threadId > 0);
  } finally { release.resolve(); await Promise.all(drains); t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});
for (const value of [false, null, 1, "true", {}])
test(`Private callback worker ownership rejects invalid policy before method work (${JSON.stringify(value)})`, async () => {
  await assert.rejects(invokeGenerativeApp({ agentDir: "/unavailable", app: "counter", method: "inspect", callbackWorkerDrain: value as true }), /Callback worker drain must be true or omitted/u);
});

for (const enabled of [false, true])
test(`Private outbound question policy uses actual bound-app init planning without method dispatch (${enabled})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-app-policy-")), agentDir = join(root, "agent");
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
  const pi = { registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI;
  const actions: TelegramOutboundButtonAction[] = [], store = createTelegramButtonActionStore();
  const planner = createTelegramOutboundReplyPlanner({ register(action) { actions.push(action); return store.register(action); } }, () => "html", enabled ? true : undefined);
  try {
    const output = '<!-- telegram_choice {"question":"Run?","choices":["counter::increment","/stop"]} -->\n<!-- telegram_button {Run|counter::increment} -->';
    const script = await writeApp(root, "counter", `export function init(){return {state:{count:0},output:${JSON.stringify(output)}}} export function increment(){return {state:{count:1},output:"called"}} export function inspect({state}){return {output:String(state.count)}}`);
    let planned = 0, displayed = 0, before = 0, after = 0;
    registerTelegramBindTool(pi, { agentDir, onOwnerObserved: store.observeAppOwner, getActiveTurn: () => ({ chatId: 42, replyToMessageId: 1, target: { chatId: 42, threadId: 7 } }),
      planOutput(markdown, options) { planned++; assert.equal(options.binding.app, "counter"); options.binding.assertCurrent!(); before = Date.now(); const plan = planner(markdown, options); after = Date.now(); return plan; },
      async sendView(view) { displayed++; assert.match(view.text, /Run/u); return { ok: true as const, value: { target: { chatId: 42, threadId: 7 }, messageIds: [201], generation: "app-policy" } }; } });
    await tool!.execute("bind", { app: "counter", script }); assert.equal(planned, 1); assert.equal(displayed, 1);
    const selections = actions.filter(a => a.promptKind === "selection"), method = actions.find(a => !a.promptKind);
    assert.equal(selections.length, 2); assert.ok(method?.binding); assert.equal(method.binding.app, "counter");
    assert.ok(selections.every(a => a.binding === undefined && a.expiresAt! >= before + (enabled ? 86_400_000 : 3_600_000) && a.expiresAt! <= after + (enabled ? 86_400_000 : 3_600_000)));
    assert.deepEqual(JSON.parse(selections[0]!.prompt), { question: "Run?", answer: "counter::increment" });
    assert.equal((await invokeGenerativeApp({ agentDir, app: "counter", method: "inspect" })).output, "0", "Planning and display must not execute the method named inside selection data");
  } finally { store.clear!(); await rm(root, { recursive: true, force: true }); }
});

async function originalAppCallbackFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-original-app-")), agentDir = join(root, "agent");
  const script = await writeApp(root, "counter", statefulApp), result = await installGenerativeApp({ agentDir, app: "counter", script });
  const binding = getGenerativeAppCallbackBinding(result), owner = captureGenerativeAppCallbackOwner(binding); assert.ok(owner);
  const appDir = resolveGenerativeAppDir(agentDir, "counter");
  return { root, agentDir, binding, owner, result, appDir, journal: join(appDir, "states.jsonl"), generation: join(appDir, "generation") };
}

for (const boundary of ["binding", "owner"] as const) for (const change of ["append", "replace", "missing", "generation", "generation-missing"] as const)
test(`Private original app owner retains observed loss after exact restoration (${boundary}/${change})`, async () => {
  const h = await originalAppCallbackFixture(), journal = await readFile(h.journal), generation = await readFile(h.generation); let moved = false, generationMoved = false;
  try {
    assert.equal(captureGenerativeAppCallbackOwner(h.binding), h.owner); assert.ok(Object.isFrozen(h.binding) && Object.isFrozen(h.owner));
    if (change === "append") await appendFile(h.journal, "\n");
    if (change === "replace" || change === "missing") { await rename(h.journal, `${h.journal}.original`); moved = true; if (change === "replace") await writeFile(h.journal, journal); }
    if (change === "generation") await writeFile(h.generation, "other");
    if (change === "generation-missing") { await rename(h.generation, `${h.generation}.original`); generationMoved = true; }
    assert.doesNotThrow(h.owner.assertObservedCurrent, "Data-only history is not fresh filesystem currentness");
    assert.throws(boundary === "binding" ? h.binding.assertCurrent : h.owner.assertCurrent, /unavailable/u);
    if (moved) { if (change === "replace") await rm(h.journal); await rename(`${h.journal}.original`, h.journal); moved = false; } else await writeFile(h.journal, journal);
    if (generationMoved) { await rename(`${h.generation}.original`, h.generation); generationMoved = false; } else await writeFile(h.generation, generation);
    assert.throws(h.owner.assertObservedCurrent, /unavailable/u); assert.throws(h.owner.assertCurrent, /unavailable/u); assert.throws(h.binding.assertCurrent, /unavailable/u);
    assert.equal(captureGenerativeAppCallbackOwner(h.binding), undefined, "An original lost cell is not renewed by recapture or restored fields");
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

for (const entry of ["guard", "history"] as const)
test(`Private original app owner poisons caught own reentry (${entry})`, async () => {
  const h = await originalAppCallbackFixture(), original = nativeFileSystem.lstatSync; let armed = true;
  try { nativeFileSystem.lstatSync = ((...args: Parameters<typeof original>) => { if (armed) { armed = false; try { (entry === "guard" ? h.owner.assertCurrent : h.owner.assertObservedCurrent)(); } catch {} } return Reflect.apply(original, nativeFileSystem, args); }) as typeof original;
    syncBuiltinESMExports(); assert.throws(h.binding.assertCurrent, /unavailable/u); assert.throws(h.owner.assertObservedCurrent, /unavailable/u);
  } finally { nativeFileSystem.lstatSync = original; syncBuiltinESMExports(); await rm(h.root, { recursive: true, force: true }); }
});

test("Private original app owner data-only history performs no filesystem or dependency calls", async () => {
  const h = await originalAppCallbackFixture(), original = nativeFileSystem.lstatSync, read = nativeFileSystem.readFileSync; let calls = 0;
  try { nativeFileSystem.lstatSync = (() => { calls++; throw Error("stat refused"); }) as typeof original; nativeFileSystem.readFileSync = (() => { calls++; throw Error("read refused"); }) as typeof read; syncBuiltinESMExports();
    for (let i = 0; i < 3; i++) h.owner.assertObservedCurrent(); assert.equal(calls, 0);
    assert.equal(captureGenerativeAppCallbackOwner(h.binding), undefined); assert.ok(calls > 0); const observed = calls;
    assert.throws(h.owner.assertObservedCurrent, /unavailable/u); assert.equal(calls, observed);
  } finally { nativeFileSystem.lstatSync = original; nativeFileSystem.readFileSync = read; syncBuiltinESMExports(); await rm(h.root, { recursive: true, force: true }); }
});

test("Private original app owner refuses DTOs, proxies and reader/constructor substitution without foreign probes", async () => {
  const h = await originalAppCallbackFixture(); let probed = 0; const ctor = h.binding.constructor as typeof h.binding.constructor & { read: (...args: unknown[]) => unknown }, reader = ctor.read;
  try { for (const fake of [undefined, {}, { ...h.binding }, Object.create(h.binding), new Proxy(h.binding, {}), { get assertCurrent() { probed++; return () => {}; }, app: "counter", generation: h.binding.generation, revision: 0 }])
      assert.equal(captureGenerativeAppCallbackOwner(fake), undefined);
    assert.equal(probed, 0); assert.equal(ctor.read(Symbol("wrong"), h.binding), undefined);
    assert.throws(() => Reflect.construct(ctor, [Symbol("wrong"), h.binding, { assertCurrent() {}, assertObservedCurrent() {} }]), /unavailable/u);
    ctor.read = () => { probed++; return h.owner; }; assert.equal(captureGenerativeAppCallbackOwner({ ...h.binding }), undefined); assert.equal(captureGenerativeAppCallbackOwner(h.binding), h.owner); assert.equal(probed, 0);
  } finally { ctor.read = reader; await rm(h.root, { recursive: true, force: true }); }
});

test("Private original app owner does not renew across real native revision while output-only calls preserve original cell", async () => {
  const h = await originalAppCallbackFixture();
  try { await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect" }); h.owner.assertCurrent(); h.owner.assertObservedCurrent();
    const next = await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "increment" }), fresh = captureGenerativeAppCallbackOwner(getGenerativeAppCallbackBinding(next)); assert.ok(fresh);
    assert.notEqual(fresh, h.owner); assert.doesNotThrow(h.owner.assertObservedCurrent, "Unobserved filesystem change is not loss history");
    assert.throws(h.binding.assertCurrent, /unavailable/u); assert.throws(h.owner.assertObservedCurrent, /unavailable/u); fresh.assertCurrent(); fresh.assertObservedCurrent();
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test("Private original app owner does not lend equal-field peer history to an observed-lost original", async () => {
  const h = await originalAppCallbackFixture(), stat = nativeFileSystem.lstatSync;
  try { const inspected = await invokeGenerativeApp({ agentDir: h.agentDir, app: "counter", method: "inspect" }), binding = getGenerativeAppCallbackBinding(inspected), peer = captureGenerativeAppCallbackOwner(binding); assert.ok(peer);
    assert.deepEqual([binding.app, binding.generation, binding.revision], [h.binding.app, h.binding.generation, h.binding.revision]); assert.notEqual(peer, h.owner);
    nativeFileSystem.lstatSync = (() => { throw Error("unavailable original observation"); }) as typeof stat; syncBuiltinESMExports(); assert.throws(h.owner.assertCurrent, /unavailable/u);
    nativeFileSystem.lstatSync = stat; syncBuiltinESMExports(); peer.assertCurrent(); peer.assertObservedCurrent();
    assert.throws(h.owner.assertObservedCurrent, /unavailable/u); assert.equal(captureGenerativeAppCallbackOwner(h.binding), undefined); assert.equal(captureGenerativeAppCallbackOwner(binding), peer);
  } finally { nativeFileSystem.lstatSync = stat; syncBuiltinESMExports(); await rm(h.root, { recursive: true, force: true }); }
});

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
    const incremented = await invokeGenerativeApp({
      agentDir,
      ...parseGenerativeAppBoundAction("counter::increment(3)")!,
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

    const minimumRefresh = await invokeGenerativeApp({
      agentDir,
      argument: 1,
      method: "scheduled",
      app: "counter",
    });
    assert.equal(minimumRefresh.refreshAfterMs, GENERATIVE_APP_MIN_REFRESH_AFTER_MS);
    const maximumRefresh = await invokeGenerativeApp({
      agentDir,
      argument: GENERATIVE_APP_MAX_REFRESH_AFTER_MS + 1,
      method: "refresh",
      app: "counter",
    });
    assert.equal(maximumRefresh.refreshAfterMs, GENERATIVE_APP_MAX_REFRESH_AFTER_MS);
    assert.equal(maximumRefresh.stateChanged, false);
    assert.equal(await readFile(journalPath, "utf8"), beforeInspect);
    for (const invalidHint of [0, -1, 1.5, Number.POSITIVE_INFINITY, "2000"]) {
      await assert.rejects(
        invokeGenerativeApp({
          agentDir,
          argument: invalidHint,
          method: "scheduled",
          app: "counter",
        }),
        /refreshAfterMs must be a finite positive integer/,
      );
    }
    await assert.rejects(
      invokeGenerativeApp({
        agentDir,
        argument: "stateful",
        method: "refresh",
        app: "counter",
      }),
      /refresh must be output-only/,
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
      (await invokeGenerativeApp({
        agentDir,
        ...parseGenerativeAppBoundAction('echo::echo({"nested":{"n":true}})')!,
      })).output,
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

test("Generative App worker never starts a process after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  try {
    const marker = join(root, "after-abort.txt");
    const script = await writeApp(
      root,
      "after-abort",
      `
export function init() { return { state: {}, output: "ready" }; }
export async function mutate({ run, signal }) {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  await run({
    command: process.execPath,
    args: ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan")`)}],
    cwd: ${JSON.stringify(root)},
    timeoutMs: 1000,
  });
  return { state: {}, output: "unreachable" };
}
`,
    );
    await installGenerativeApp({ agentDir, app: "after-abort", script });
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
      app: "after-abort",
    });
    setTimeout(() => execution.abort(), 200);
    await assert.rejects(pending, /cancelled|stale execution/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(readFile(marker), /ENOENT/, "A cancelled method cannot leave an orphan process behind");
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

for (const scenario of ["owned", "legacy", "copied", "accessor", "peer", "getter", "renamed", "source-loss", "restored-fields", "reentry", "replacement", "input-swap", "plan-loss", "edit-loss", "retry"] as const)
test(`Native live refresh source pins the original app before callbacks (${scenario})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-live-source-")), agentDir = join(root, "agent"), marker = join(root, "refresh-count.txt");
  let runtime: ReturnType<typeof createGenerativeAppLiveSurfaceRuntime<string>> | undefined;
  let planned = 0, edited = 0, scheduled = 0, getterReads = 0, once = false, observedBinding: ReturnType<typeof getGenerativeAppCallbackBinding> | undefined;
  let observedSurface: { originalAppBinding?: ReturnType<typeof getGenerativeAppCallbackBinding> } | undefined;
  try {
    const script = await writeApp(root, "dashboard", `
import {readFile, writeFile} from "node:fs/promises";
export function init(){return {state:{count:0},output:"initial",refreshAfterMs:60000}}
export function view(){return {output:"peer"}}
export async function refresh(){let n=0;try{n=Number(await readFile(${JSON.stringify(marker)},"utf8"))}catch(e){if(e.code!=="ENOENT")throw e}await writeFile(${JSON.stringify(marker)},String(n+1));return {output:"fresh"}}
`);
    const installed = await installGenerativeApp({ agentDir, app: "dashboard", script }), original = getGenerativeAppCallbackBinding(installed), owner = captureGenerativeAppCallbackOwner(original)!;
    const peer = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir, app: "dashboard", method: "view" }));
    assert.notEqual(peer, original); for (const field of ["app", "generation", "revision"] as const) assert.equal(peer[field], original[field]);
    const journal = join(resolveGenerativeAppDir(agentDir, "dashboard"), "states.jsonl");
    runtime = createGenerativeAppLiveSurfaceRuntime<string>({
      agentDir, isCurrent(surface) {
        if (!once) {
          once = true;
          observedSurface = surface;
          if (scenario === "peer" || scenario === "restored-fields") surface.originalAppBinding = peer;
          if (scenario === "getter") Object.defineProperty(surface, "originalAppBinding", { get() { getterReads++; return original; } });
          if (scenario === "renamed") surface.app = "foreign";
          if (scenario === "source-loss") nativeFileSystem.appendFileSync(journal, "\n");
          if (scenario === "reentry") void runtime!.refreshNow("surface");
          if (scenario === "replacement") runtime!.open({ ...surface, handle: "replacement", originalAppBinding: peer });
        }
        return true;
      },
      plan(result, handle) {
        planned++; observedBinding = getGenerativeAppCallbackBinding(result);
        assert.equal(!!owner.captureReadOnlySuccessor!(observedBinding), scenario !== "legacy", "Native lineage joins the captured source, never equal fields or a fake callback");
        if (scenario === "plan-loss") nativeFileSystem.appendFileSync(journal, "\n");
        return { digest: result.output, handle };
      },
      edit: async frame => { edited++; if (scenario === "edit-loss") nativeFileSystem.appendFileSync(journal, "\n"); if (scenario === "retry" && edited === 1) throw Error("retry"); return frame.handle; },
      classifyEditError: () => { if (scenario === "restored-fields") observedSurface!.originalAppBinding = original; return { kind: "retry" }; },
      setTimer() { scheduled++; return { unref() {} } as ReturnType<typeof setTimeout>; }, clearTimer() {},
    });
    const surface = { app: "dashboard", appGeneration: installed.generation, appRevision: installed.revision, handle: "message", initialDigest: "initial", key: "surface", refreshAfterMs: 60000,
      ...(scenario !== "legacy" ? { originalAppBinding: original } : {}) };
    if (scenario === "copied") surface.originalAppBinding = { ...original };
    if (scenario === "accessor") Object.defineProperty(surface, "originalAppBinding", { get() { getterReads++; return original; } });
    if (scenario === "copied" || scenario === "accessor") {
      assert.throws(() => runtime!.open(surface), /live source is unavailable/u); assert.equal(scheduled, 0);
    } else {
      runtime.open(surface); if (scenario === "input-swap") surface.originalAppBinding = peer;
      await runtime.refreshNow("surface"); if (scenario === "retry") await runtime.refreshNow("surface");
    }
    assert.equal(getterReads, 0, "Foreign binding accessors are refused without execution");
    const noWorker = ["copied", "accessor", "peer", "getter", "renamed", "source-loss", "restored-fields", "replacement"].includes(scenario);
    if (noWorker) { await assert.rejects(readFile(marker), /ENOENT/u); assert.equal(planned, 0); assert.equal(edited, 0); }
    else { assert.equal(await readFile(marker, "utf8"), "1"); assert.equal(planned, 1); assert.equal(edited, scenario === "plan-loss" ? 0 : scenario === "retry" ? 2 : 1); }
    if (scenario === "replacement") assert.equal(runtime.take("surface")?.handle, "replacement", "Obsolete caller cannot cancel or execute its replacement");
    else if (!["copied", "accessor"].includes(scenario)) assert.equal(runtime.take("surface"), undefined);
    if (["peer", "getter", "renamed", "source-loss", "restored-fields", "plan-loss", "edit-loss"].includes(scenario)) assert.equal(scheduled, 1, "Retry classification cannot revive a lost original source");
  } finally { runtime?.shutdown(); await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["owned", "omitted", "missing", "throw", "async", "getter", "then-getter", "unfrozen", "lost", "retry", "retry-missing", "reentry", "replacement", "shutdown", "provider-swap", "next-refresh"] as const)
test(`Native refresh publication handoff captures before callbacks without global SDK guard (${scenario})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-live-publication-")), agentDir = join(root, "agent"), marker = join(root, "refresh-count.txt");
  let runtime: ReturnType<typeof createGenerativeAppLiveSurfaceRuntime<string>> | undefined;
  let captures = 0, foreignCaptures = 0, planned = 0, edited = 0, getterReads = 0, assertionCalls = 0, observed = false;
  const sources: unknown[] = [];
  const source = Object.freeze({ assertCurrent() { assertionCalls++; throw Error("SDK eligibility is not app execution authority"); } });
  try {
    const script = await writeApp(root, "dashboard", `
import {readFile,writeFile} from "node:fs/promises";
export function init(){return {state:{count:0},output:"initial",refreshAfterMs:60000}}
export async function refresh(context){if("originalPublicationSource" in context)throw Error("Main-side provenance entered worker data");let n=0;try{n=Number(await readFile(${JSON.stringify(marker)},"utf8"))}catch(e){if(e.code!=="ENOENT")throw e}await writeFile(${JSON.stringify(marker)},String(n+1));return {output:"fresh"+n${scenario === "next-refresh" ? ",refreshAfterMs:60000" : ""}}}
`);
    const installed = await installGenerativeApp({ agentDir, app: "dashboard", script }), original = getGenerativeAppCallbackBinding(installed), owner = captureGenerativeAppCallbackOwner(original)!;
    const surface = { app: "dashboard", appGeneration: installed.generation, appRevision: installed.revision, handle: "message", initialDigest: "initial", key: "surface", refreshAfterMs: 60000, originalAppBinding: original };
    const deps: Parameters<typeof createGenerativeAppLiveSurfaceRuntime<string>>[0] = {
      agentDir,
      capturePublicationSource(handle, binding) {
        assert.equal(this, deps); assert.equal(handle, "message"); assert.equal(binding, original); captures++;
        assert.equal(nativeFileSystem.existsSync(marker), scenario === "next-refresh" && captures === 2);
        assert.equal(planned, scenario === "next-refresh" ? captures - 1 : 0);
        if (scenario === "throw") throw Error("SDK source unavailable");
        if (scenario === "async") return Promise.reject(Error("Not a synchronous source")) as never;
        if (scenario === "getter") return Object.freeze(Object.defineProperty({}, "assertCurrent", { get() { getterReads++; return source.assertCurrent; } })) as never;
        if (scenario === "then-getter") return Object.freeze(Object.defineProperty({}, "then", { get() { getterReads++; throw Error("Foreign then getter"); } })) as never;
        if (scenario === "unfrozen") return { assertCurrent: source.assertCurrent };
        if (scenario === "reentry") void runtime!.refreshNow("surface");
        if (scenario === "replacement") runtime!.open({ ...surface, handle: "replacement" });
        if (scenario === "shutdown") runtime!.shutdown();
        return scenario === "missing" || scenario === "retry-missing" && captures === 1 ? undefined : source;
      },
      isCurrent() { if (scenario !== "omitted") assert.equal(captures > 0, true); return true; },
      onOwnerObserved() { observed = true; if (scenario !== "omitted") assert.equal(captures > 0, true); },
      plan(result, handle) {
        planned++; const binding = getGenerativeAppCallbackBinding(result), next = owner.captureReadOnlySuccessor!(binding); assert.ok(next);
        const captured = next.originalPublicationSource;
        const expected = ["omitted", "missing", "throw", "async", "getter", "then-getter", "unfrozen", "retry-missing"].includes(scenario) ? undefined : source;
        assert.equal(captured, expected); sources.push(captured);
        assert.equal(Object.isFrozen(next), true);
        assert.equal(Object.keys(next).includes("originalPublicationSource"), false);
        if (scenario === "lost") assert.throws((captured as typeof source).assertCurrent);
        assert.equal(owner.captureReadOnlySuccessor!({ ...binding }), undefined);
        return { digest: result.output, handle };
      },
      edit: async frame => { edited++; if ((scenario === "retry" || scenario === "retry-missing") && edited === 1) throw Error("retry"); return frame.handle; },
      classifyEditError: () => ({ kind: "retry" }),
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>, clearTimer() { if (scenario !== "omitted") assert.equal(captures > 0, true); },
    };
    if (scenario === "omitted") delete deps.capturePublicationSource;
    runtime = createGenerativeAppLiveSurfaceRuntime(deps);
    if (scenario === "provider-swap") deps.capturePublicationSource = () => { foreignCaptures++; return undefined; };
    runtime.open(surface); await runtime.refreshNow("surface");
    if (scenario === "retry" || scenario === "retry-missing" || scenario === "next-refresh") await runtime.refreshNow("surface");
    assert.equal(captures, scenario === "omitted" ? 0 : scenario === "next-refresh" ? 2 : 1); assert.equal(foreignCaptures, 0); assert.equal(getterReads, 0);
    if (scenario === "replacement" || scenario === "shutdown") {
      await assert.rejects(readFile(marker), /ENOENT/u); assert.equal(planned, 0); assert.equal(edited, 0); assert.equal(observed, false);
      if (scenario === "replacement") assert.equal(runtime.take("surface")?.handle, "replacement");
    } else {
      assert.equal(await readFile(marker, "utf8"), scenario === "next-refresh" ? "2" : "1");
      assert.equal(planned, scenario === "next-refresh" ? 2 : 1); assert.equal(edited, ["retry", "retry-missing", "next-refresh"].includes(scenario) ? 2 : 1);
      assert.equal(sources.length, planned);
    }
    assert.equal(assertionCalls, scenario === "lost" ? 1 : 0, "Opaque SDK eligibility is never run as a global worker/edit guard");
  } finally { runtime?.shutdown(); await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["owned", "getter", "no-binding", "no-drain", "other-method", "invocation", "changed-option"] as const)
test(`Native refresh publication association stays on the exact main-side result (${scenario})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-refresh-association-")), agentDir = join(root, "agent"), marker = join(root, "worker.txt");
  let getterReads = 0;
  try {
    const script = await writeApp(root, "dashboard", `
import {writeFile} from "node:fs/promises";
export function init(){return {state:{count:0},output:"initial"}}
export function view(){return {output:"peer"}}
export async function refresh(context){if("originalPublicationSource" in context)throw Error("Provenance entered worker");await writeFile(${JSON.stringify(marker)},"once");return {output:"fresh"}}
`);
    const installed = await installGenerativeApp({ agentDir, app: "dashboard", script }), original = getGenerativeAppCallbackBinding(installed), owner = captureGenerativeAppCallbackOwner(original)!;
    const source = Object.freeze({ assertCurrent() { throw Error("Not an execution grant"); } }), peer = Object.freeze({ assertCurrent() {} });
    const options: Parameters<typeof invokeGenerativeApp>[0] = { agentDir, app: "dashboard", method: "refresh", callbackWorkerDrain: true, callbackBinding: original, originalPublicationSource: source };
    if (scenario === "getter") Object.defineProperty(options, "originalPublicationSource", { get() { getterReads++; return source; } });
    if (scenario === "no-binding") delete options.callbackBinding;
    if (scenario === "no-drain") delete options.callbackWorkerDrain;
    if (scenario === "other-method") options.method = "view";
    const origin = {}, invocation = scenario === "invocation" ? owner.createCallbackInvocation!("dashboard::refresh", origin) : undefined;
    if (invocation) options.callbackInvocation = invocation;
    if (scenario === "changed-option") options.onOwnerObserved = () => { options.originalPublicationSource = peer; options.method = "view"; };
    if (["getter", "no-binding", "no-drain", "other-method", "invocation"].includes(scenario)) {
      await assert.rejects(invokeGenerativeApp(options), /refresh publication source is unavailable/u); await assert.rejects(readFile(marker), /ENOENT/u);
      if (invocation) {
        const result = await invokeGenerativeApp({ agentDir, app: "dashboard", method: "refresh", callbackWorkerDrain: true, callbackBinding: original, callbackInvocation: invocation });
        assert.ok(owner.captureReadOnlySuccessor!(getGenerativeAppCallbackBinding(result), invocation, origin), "Refusing the SDK association cannot spend a native callback invocation");
      }
    } else {
      const result = await invokeGenerativeApp(options), binding = getGenerativeAppCallbackBinding(result), next = owner.captureReadOnlySuccessor!(binding); assert.ok(next);
      assert.deepEqual(getGenerativeAppRefreshPublicationSource(binding), { source, predecessor: owner });
      assert.equal(getGenerativeAppRefreshPublicationSource({ ...binding }), undefined);
      assert.equal(next.originalPublicationSource, source); assert.equal(result.method, "refresh"); assert.equal(await readFile(marker, "utf8"), "once");
      const descriptor = Object.getOwnPropertyDescriptor(next, "originalPublicationSource")!; assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false); assert.equal(descriptor.enumerable, false);
      assert.throws(() => getGenerativeAppCallbackBinding({ ...result }), /not native-owned/u);
      const unrelated = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir, app: "dashboard", method: "view", callbackWorkerDrain: true, callbackBinding: original }));
      assert.equal(getGenerativeAppRefreshPublicationSource(unrelated), undefined);
      assert.equal(owner.captureReadOnlySuccessor!(unrelated)!.originalPublicationSource, undefined, "Equal app/generation/revision and genuine native lineage cannot borrow another result's source");
      const later = getGenerativeAppCallbackBinding(await invokeGenerativeApp({ agentDir, app: "dashboard", method: "view", callbackWorkerDrain: true, callbackBinding: binding }));
      assert.equal(next.captureReadOnlySuccessor!(later)!.originalPublicationSource, undefined, "A genuine later successor cannot inherit the refresh's source implicitly");
    }
    assert.equal(getterReads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["read-only", "state-written", "copied", "foreign", "metadata", "getter", "plan-loss", "edit-loss", "current-replace", "plan-replace", "edit-replace", "current-stop", "plan-stop", "edit-stop"] as const)
test(`Native live refresh resume keeps the genuine next producer (${scenario})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-live-resume-")), agentDir = join(root, "agent");
  let runtime: ReturnType<typeof createGenerativeAppLiveSurfaceRuntime<string>> | undefined;
  let planned = 0, edited = 0, getterReads = 0;
  try {
    const script = await writeApp(root, "dashboard", `
export function init(){return {state:{count:0},output:"initial",refreshAfterMs:60000}}
export function view(){return {output:"next",refreshAfterMs:60000}}
export function increment({state}){return {state:{count:state.count+1},output:"next",refreshAfterMs:60000}}
export function refresh(){return {output:"fresh"}}
`);
    const installed = await installGenerativeApp({ agentDir, app: "dashboard", script }), original = getGenerativeAppCallbackBinding(installed);
    let result = await invokeGenerativeApp({ agentDir, app: "dashboard", method: scenario === "state-written" ? "increment" : "view", callbackWorkerDrain: true, callbackBinding: original });
    const nextBinding = getGenerativeAppCallbackBinding(result), nextOwner = captureGenerativeAppCallbackOwner(nextBinding)!;
    const journal = join(resolveGenerativeAppDir(agentDir, "dashboard"), "states.jsonl");
    runtime = createGenerativeAppLiveSurfaceRuntime<string>({ agentDir, isCurrent(value) {
        if (scenario === "current-replace") runtime!.open({ ...value, handle: "replacement" });
        if (scenario === "current-stop") runtime!.shutdown();
        return true;
      },
      plan(value, handle) { planned++; if (value.method === "refresh") assert.ok(nextOwner.captureReadOnlySuccessor!(getGenerativeAppCallbackBinding(value)));
        if (scenario === "plan-loss") nativeFileSystem.appendFileSync(journal, "\n");
        if (scenario === "plan-replace") runtime!.open({ ...surface, handle: "replacement" });
        if (scenario === "plan-stop") runtime!.shutdown();
        return { digest: value.output, handle }; },
      edit: async frame => { edited++; if (scenario === "edit-loss") nativeFileSystem.appendFileSync(journal, "\n");
        if (scenario === "edit-replace") runtime!.open({ ...surface, handle: "replacement" });
        if (scenario === "edit-stop") runtime!.shutdown();
        return frame.handle; },
      setTimer() { return { unref() {} } as ReturnType<typeof setTimeout>; }, clearTimer() {},
    });
    runtime.open({ app: "dashboard", appGeneration: installed.generation, appRevision: installed.revision, originalAppBinding: original, handle: "message", initialDigest: "initial", key: "surface", refreshAfterMs: 60000 });
    const surface = runtime.take("surface")!;
    if (scenario === "copied") result = { ...result };
    if (scenario === "foreign") result = await installGenerativeApp({ agentDir, app: "foreign", script: await writeApp(root, "foreign", await readFile(script, "utf8")) });
    if (scenario === "metadata") result.revision++;
    if (scenario === "getter") Object.defineProperty(result, "revision", { get() { getterReads++; return nextBinding.revision; } });
    if (scenario === "read-only" || scenario === "state-written") {
      await runtime.resume(surface, result);
      const resumed = runtime.take("surface")!; assert.ok(resumed); assert.equal(resumed.originalAppBinding, nextBinding);
      runtime.open(resumed); await runtime.refreshNow("surface"); assert.equal(planned, 2); assert.equal(edited, 2);
    } else if (scenario.endsWith("replace") || scenario.endsWith("stop")) {
      await runtime.resume(surface, result);
      assert.equal(planned, scenario.startsWith("current") ? 0 : 1); assert.equal(edited, scenario.startsWith("edit") ? 1 : 0);
      if (scenario.endsWith("replace")) assert.equal(runtime.take("surface")?.handle, "replacement", "A superseded resume cannot reopen over its replacement");
    } else {
      await assert.rejects(runtime.resume(surface, result), /live source|not native-owned|owner is unavailable/u);
      assert.equal(edited, scenario === "edit-loss" ? 1 : 0); assert.equal(planned, ["plan-loss", "edit-loss"].includes(scenario) ? 1 : 0);
    }
    assert.equal(getterReads, 0); assert.equal(runtime.take("surface"), undefined);
  } finally { runtime?.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("Generative App live surfaces suppress unchanged frames, remain non-overlapping, and close on omitted hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  const timers: Array<() => void> = [];
  const edits: string[] = [];
  try {
    const script = await writeApp(
      root,
      "dashboard",
      `
export function init() { return { state: { tick: 0 }, output: "same", refreshAfterMs: 2000 }; }
export async function refresh() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { output: "same", refreshAfterMs: 2000 };
}
`,
    );
    const installed = await installGenerativeApp({ agentDir, app: "dashboard", script });
    const runtime = createGenerativeAppLiveSurfaceRuntime<string>({
      agentDir,
      isCurrent: () => true,
      plan: (result, handle) => ({ digest: result.output, handle }),
      edit: async (frame) => {
        edits.push(frame.digest);
        return frame.handle;
      },
      setTimer(callback) {
        timers.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    runtime.open({
      app: "dashboard",
      appGeneration: installed.generation,
      appRevision: installed.revision,
      handle: "message-1",
      initialDigest: "same",
      key: "dashboard/default/1",
      refreshAfterMs: installed.refreshAfterMs!,
    });
    assert.equal(timers.length, 1);
    await Promise.all([
      runtime.refreshNow("dashboard/default/1"),
      runtime.refreshNow("dashboard/default/1"),
    ]);
    assert.deepEqual(edits, []);
    assert.equal(timers.length, 2);
    const taken = runtime.take("dashboard/default/1");
    assert.equal(taken?.handle, "message-1");
    assert.equal(taken?.appRevision, installed.revision);
    assert.equal(runtime.take("dashboard/default/1"), undefined);
    runtime.open({
      ...taken!,
      appRevision: installed.revision + 1,
      initialDigest: "action-frame",
    });
    assert.equal(timers.length, 3);
    runtime.cancel("dashboard/default/1");
    await runtime.refreshNow("dashboard/default/1");
    assert.deepEqual(edits, []);
    runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App live surfaces fence a cancelled in-flight refresh from its replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  const edits: string[] = [];
  let plans = 0;
  try {
    const script = await writeApp(root, "handoff-dashboard", `
export function init() { return { state: {}, output: "initial", refreshAfterMs: 2000 }; }
export async function refresh() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { output: "stale-refresh", refreshAfterMs: 3000 };
}
`);
    const installed = await installGenerativeApp({ agentDir, app: "handoff-dashboard", script });
    const runtime = createGenerativeAppLiveSurfaceRuntime<string>({
      agentDir,
      isCurrent: () => true,
      plan: (result, handle) => {
        plans += 1;
        return { digest: result.output, handle };
      },
      edit: async (frame) => {
        edits.push(frame.digest);
        return frame.handle;
      },
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    const key = "handoff-dashboard/default/1";
    const original = {
      app: "handoff-dashboard",
      appGeneration: installed.generation,
      appRevision: installed.revision,
      handle: "message-1",
      initialDigest: "initial",
      key,
      refreshAfterMs: installed.refreshAfterMs!,
    };
    runtime.open(original);
    const refresh = runtime.refreshNow(key);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.take(key)?.handle, "message-1");
    runtime.open({ ...original, handle: "message-2", initialDigest: "action-frame" });
    await refresh;
    assert.equal(plans, 0);
    assert.deepEqual(edits, []);
    assert.equal(runtime.take(key)?.handle, "message-2");
    runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App live surfaces retry one retained frame without re-invoking refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  let plans = 0;
  let edits = 0;
  try {
    const script = await writeApp(root, "retry-dashboard", `
export function init() { return { state: {}, output: "initial", refreshAfterMs: 2000 }; }
export function refresh() { return { output: "changed", refreshAfterMs: 3000 }; }
`);
    const installed = await installGenerativeApp({ agentDir, app: "retry-dashboard", script });
    const runtime = createGenerativeAppLiveSurfaceRuntime<string>({
      agentDir,
      isCurrent: () => true,
      plan: (result, handle) => {
        plans += 1;
        return { digest: result.output, handle };
      },
      edit: async (frame) => {
        edits += 1;
        if (edits === 1) throw Object.assign(new Error("limited"), { retryAfterMs: 7000 });
        return frame.handle;
      },
      classifyEditError: (error) => ({
        kind: "retry",
        retryAfterMs: (error as { retryAfterMs: number }).retryAfterMs,
      }),
      setTimer(callback, delayMs) {
        timers.push({ callback, delayMs });
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    runtime.open({
      app: "retry-dashboard",
      appGeneration: installed.generation,
      appRevision: installed.revision,
      handle: "message-1",
      initialDigest: "initial",
      key: "retry-dashboard/default/1",
      refreshAfterMs: installed.refreshAfterMs!,
    });
    await runtime.refreshNow("retry-dashboard/default/1");
    assert.equal(timers.at(-1)?.delayMs, 7000);
    await runtime.refreshNow("retry-dashboard/default/1");
    assert.equal(plans, 1);
    assert.equal(edits, 2);
    assert.equal(timers.at(-1)?.delayMs, 3000);
    runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App live surfaces invalidate unavailable deliveries with bounded diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  const events: Array<{ category: string; details?: Record<string, unknown> }> = [];
  let plans = 0;
  try {
    const script = await writeApp(root, "deleted-dashboard", `
export function init() { return { state: {}, output: "initial", refreshAfterMs: 2000 }; }
export function refresh() { return { output: "changed", refreshAfterMs: 3000 }; }
`);
    const installed = await installGenerativeApp({ agentDir, app: "deleted-dashboard", script });
    const runtime = createGenerativeAppLiveSurfaceRuntime<string>({
      agentDir,
      isCurrent: () => true,
      plan: (result, handle) => {
        plans += 1;
        return { digest: result.output, handle };
      },
      edit: async () => {
        throw new Error("message to edit not found");
      },
      classifyEditError: () => ({ kind: "unavailable" }),
      recordRuntimeEvent(category, _error, details) {
        events.push({ category, details });
      },
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    const key = "deleted-dashboard/default/1";
    runtime.open({
      app: "deleted-dashboard",
      appGeneration: installed.generation,
      appRevision: installed.revision,
      handle: "message-1",
      initialDigest: "initial",
      key,
      refreshAfterMs: installed.refreshAfterMs!,
    });
    await runtime.refreshNow(key);
    await runtime.refreshNow(key);
    assert.equal(plans, 1);
    assert.equal(runtime.take(key), undefined);
    assert.deepEqual(events, [{
      category: "generative-app",
      details: {
        phase: "live-surface-refresh",
        app: "deleted-dashboard",
        outcome: "unavailable",
      },
    }]);
    runtime.shutdown();
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

for (const change of ["increment", "replace", "init"] as const)
test(`Native owner changes retire app callbacks without new views or further input (${change})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent");
  const store = createTelegramButtonActionStore();
  const edits: TelegramInlineKeyboardMarkup[] = [];
  let shown = 0, planned = 0;
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
  const pi = { registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    editMessageReplyMarkup: async (_chat: number, _id: number, markup: TelegramInlineKeyboardMarkup) => { edits.push(markup); },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  try {
    const script = await writeApp(root, "counter", statefulApp);
    const installed = await installGenerativeApp({ agentDir, app: "counter", script, onOwnerObserved: store.observeAppOwner });
    const binding = getGenerativeAppCallbackBinding(installed);
    const plan = planTelegramButtonReply('<!-- telegram_button [{"label":"A","prompt":"counter::increment"},{"label":"B","prompt":"counter::inspect"}] -->',
      { registerAction: store.register, binding });
    const other = store.register({ text: "Other app", prompt: "other::next", binding: { app: "other", generation: "other-generation", revision: 0 } });
    plan.replyMarkup!.inline_keyboard.push([{ text: "Other app", callback_data: other }]);
    await api.sendMessage({ chat_id: 7, text: "Initial", reply_markup: plan.replyMarkup });
    registerTelegramBindTool(pi, { agentDir, onOwnerObserved: store.observeAppOwner, getActiveTurn: () => ({ chatId: 7, replyToMessageId: 1 }),
      planOutput() { planned++; return { markdown: "Must not display" }; }, async sendMarkdownReply() { shown++; return 12; } });
    await tool!.execute("inspect", { app: "counter", method: "inspect", display: false });
    await store.waitForPublicationIdle!(); binding.assertCurrent(); assert.equal(edits.length, 0);
    await assert.rejects(tool!.execute("failed", { app: "counter", script, replace: true, argument: { fail: true }, display: false }), /init rejected/u);
    binding.assertCurrent(); await store.waitForPublicationIdle!(); assert.equal(edits.length, 0);
    const changed = await tool!.execute("changed", { app: "counter", ...(change === "replace" ? { script, replace: true } : { method: change }), display: false }) as { isError?: boolean };
    assert.notEqual(changed.isError, true);
    await store.waitForPublicationIdle!();
    assert.equal(edits.length, 1, "Native commit must retire the footer before resolve/register or another publication");
    for (const button of edits[0]!.inline_keyboard.slice(0, -1).flat()) assert.deepEqual(button.disabled, {});
    assert.equal(edits[0]!.inline_keyboard.at(-1)![0]!.callback_data, other);
    assert.equal(shown, 0); assert.equal(planned, 0);
    for (const button of plan.replyMarkup!.inline_keyboard.slice(0, -1).flat()) assert.equal(store.resolve(button.callback_data), undefined);
    assert.equal(store.resolve(other)!.prompt, "other::next");
    assert.throws(binding.assertCurrent, /owner is unavailable/u);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); await rm(root, { recursive: true, force: true }); }
});

test("Callback owner proof is native-only, immutable and rejects init revision-zero reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent");
  const store = createTelegramButtonActionStore();
  try {
    const script = await writeApp(root, "counter", statefulApp);
    const first = await installGenerativeApp({ agentDir, app: "counter", script, onOwnerObserved: store.observeAppOwner });
    const old = getGenerativeAppCallbackBinding(first);
    const fresh = await invokeGenerativeApp({ agentDir, app: "counter", method: "init", onOwnerObserved: store.observeAppOwner });
    assert.equal(first.generation, fresh.generation); assert.equal(first.revision, fresh.revision);
    assert.throws(old.assertCurrent, /owner is unavailable/u);
    const binding = getGenerativeAppCallbackBinding(fresh);
    const key = store.register({ text: "New", prompt: "counter::increment", binding });
    assert.throws(() => store.register({ text: "Old", prompt: "counter::increment", binding: old }), /owner is unavailable/u);
    assert.equal(store.resolve(key)!.prompt, "counter::increment", "A stale initial result cannot evict a genuine new run");
    assert.throws(() => getGenerativeAppCallbackBinding({ ...fresh }), /not native-owned/u);
    assert.equal(JSON.stringify(fresh).includes("assertCurrent"), false);
    fresh.app = "forged"; fresh.revision = 99;
    assert.equal(getGenerativeAppCallbackBinding(fresh), binding);
    assert.equal(binding.app, "counter"); assert.equal(binding.revision, 0); assert.equal(Object.isFrozen(binding), true); binding.assertCurrent();
  } finally { store.clear!(); await rm(root, { recursive: true, force: true }); }
});

test("A queued bound method rechecks native ownership inside the actual app transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent"), effect = join(root, "business-effect");
  try {
    const marked = 'import { writeFile } from "node:fs/promises";\n' + statefulApp.replace("export function increment", "export async function increment")
      .replace("  const next =", "  await writeFile(" + JSON.stringify(effect) + ', "executed");\n  const next =');
    const script = await writeApp(root, "counter", marked);
    const first = await installGenerativeApp({ agentDir, app: "counter", script }), binding = getGenerativeAppCallbackBinding(first);
    let reset: ReturnType<typeof invokeGenerativeApp> | undefined;
    await invokeGenerativeApp({ agentDir, app: "counter", method: "inspect", onOwnerObserved(owner) {
      if (owner.revision !== undefined && !reset) reset = invokeGenerativeApp({ agentDir, app: "counter", method: "init" });
    } });
    const delayed = invokeGenerativeApp({ agentDir, app: "counter", method: "increment",
      expectedGeneration: first.generation, expectedRevision: first.revision, assertCallbackOwner: binding.assertCurrent });
    const refused = assert.rejects(delayed, /owner is unavailable/u);
    await reset; await refused;
    await assert.rejects(stat(effect), { code: "ENOENT" }, "The stale worker must not execute a business effect before failing its commit");
    assert.deepEqual(JSON.parse(await readFile(join(resolveGenerativeAppDir(agentDir, "counter"), "state.json"), "utf8")), { count: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unobserved foreign-style state change cannot activate delayed native result callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent");
  const store = createTelegramButtonActionStore();
  let sent: TelegramInlineKeyboardMarkup | undefined;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async (body: { reply_markup?: TelegramInlineKeyboardMarkup }) => { sent = body.reply_markup; return { message_id: 11 }; } } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  try {
    const script = await writeApp(root, "counter", statefulApp);
    const first = await installGenerativeApp({ agentDir, app: "counter", script });
    const binding = getGenerativeAppCallbackBinding(first);
    const key = store.register({ text: "A", prompt: "counter::increment", binding });
    await invokeGenerativeApp({ agentDir, app: "counter", method: "increment" }); // No observer: simulate another native owner.
    await api.sendMessage({ chat_id: 7, text: "Delayed", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: key }]] } });
    assert.deepEqual(sent!.inline_keyboard[0]![0]!.disabled, {});
    assert.equal(store.resolve(key), undefined);
    assert.throws(() => store.register({ text: "Late", prompt: "counter::increment", binding }), /owner is unavailable/u);
    await store.waitForPublicationIdle!();
  } finally { store.clear!(); await store.waitForPublicationIdle!(); await rm(root, { recursive: true, force: true }); }
});

test("Published callback guards close siblings on foreign change and stay lost after equal restoration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent");
  const store = createTelegramButtonActionStore();
  let edits = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    editMessageReplyMarkup: async () => { edits++; } } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  try {
    const script = await writeApp(root, "counter", statefulApp), first = await installGenerativeApp({ agentDir, app: "counter", script });
    const binding = getGenerativeAppCallbackBinding(first), journal = join(resolveGenerativeAppDir(agentDir, "counter"), "states.jsonl");
    const original = await readFile(journal, "utf8");
    const keys = [store.register({ text: "A", prompt: "counter::increment", binding }), store.register({ text: "B", prompt: "counter::inspect", binding })];
    await api.sendMessage({ chat_id: 7, text: "Initial", reply_markup: { inline_keyboard: [keys.map(key => ({ text: "Button", callback_data: key }))] } });
    await invokeGenerativeApp({ agentDir, app: "counter", method: "increment" });
    assert.equal(store.resolve(keys[0]), undefined); assert.equal(store.resolve(keys[1]), undefined);
    await store.waitForPublicationIdle!(); assert.equal(edits, 1);
    await writeFile(journal, original, "utf8");
    assert.throws(binding.assertCurrent, /owner is unavailable/u);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); await rm(root, { recursive: true, force: true }); }
});

test("An existing live refresh observes replacement and retires callbacks without planning a view", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent");
  const store = createTelegramButtonActionStore();
  let edits = 0, planned = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    editMessageReplyMarkup: async () => { edits++; } } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const live = createGenerativeAppLiveSurfaceRuntime({ agentDir, onOwnerObserved: store.observeAppOwner, isCurrent: () => true,
    plan() { planned++; return { digest: "not-used", handle: "handle" }; }, edit: async frame => frame.handle });
  try {
    const script = await writeApp(root, "counter", statefulApp), first = await installGenerativeApp({ agentDir, app: "counter", script });
    const key = store.register({ text: "A", prompt: "counter::increment", binding: getGenerativeAppCallbackBinding(first) });
    await api.sendMessage({ chat_id: 7, text: "Initial", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: key }]] } });
    live.open({ key: "view", app: "counter", appGeneration: first.generation, appRevision: first.revision, handle: "handle", initialDigest: "initial", refreshAfterMs: 60_000 });
    await installGenerativeApp({ agentDir, app: "counter", script, replace: true });
    await live.refreshNow("view"); await store.waitForPublicationIdle!();
    assert.equal(edits, 1); assert.equal(planned, 0); assert.equal(live.take("view"), undefined); assert.equal(store.resolve(key), undefined);
  } finally { live.shutdown(); store.clear!(); await store.waitForPublicationIdle!(); await rm(root, { recursive: true, force: true }); }
});

test("Native owner change waits for actual body I/O and closes the latest acknowledged view", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent");
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const edits: string[] = [];
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendRichMessage: async () => ({ message_id: 11 }),
    async editMessageText(body: { rich_message: { markdown: string } }) { edits.push(body.rich_message.markdown); if (edits.length === 1) { entered.resolve(); await release.promise; } return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  try {
    const script = await writeApp(root, "counter", statefulApp);
    const first = await installGenerativeApp({ agentDir, app: "counter", script, onOwnerObserved: store.observeAppOwner });
    const binding = getGenerativeAppCallbackBinding(first), key = store.register({ text: "A", prompt: "counter::increment", binding });
    const row = '<tg-button-row><tg-button type="callback_data" data="' + key + '">A</tg-button></tg-button-row>';
    await api.sendRichMessage({ chat_id: 7, rich_message: { markdown: "Original\n" + row } });
    const pending = api.editMessageText({ chat_id: 7, message_id: 11, rich_message: { markdown: "Newer\n" + row } });
    await entered.promise;
    await invokeGenerativeApp({ agentDir, app: "counter", method: "increment", onOwnerObserved: store.observeAppOwner });
    assert.equal(edits.length, 1);
    let idle = false; const drain = store.waitForPublicationIdle!().then(() => { idle = true; });
    await Promise.resolve(); assert.equal(idle, false);
    release.resolve(); await pending; await drain;
    assert.deepEqual(edits, ["Newer\n" + row, "Newer\n" + row.replace('type="callback_data" data="' + key + '"', 'type="disabled"')]);
    assert.equal(store.resolve(key), undefined);
  } finally { release.resolve(); store.clear!(); await store.waitForPublicationIdle!(); await rm(root, { recursive: true, force: true }); }
});

test("Owner-observation failures cannot interrupt a committed native transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-app-owner-")), agentDir = join(root, "agent");
  const failures: unknown[] = [];
  try {
    const script = await writeApp(root, "counter", statefulApp);
    await installGenerativeApp({ agentDir, app: "counter", script });
    const result = await invokeGenerativeApp({ agentDir, app: "counter", method: "increment",
      onOwnerObserved() { throw new Error("Observer failed"); }, recordRuntimeEvent(_category, error) { failures.push(error); } });
    assert.equal(result.revision, 1); assert.equal(result.output, "1"); assert.ok(failures.length > 0);
    assert.deepEqual(JSON.parse(await readFile(join(resolveGenerativeAppDir(agentDir, "counter"), "state.json"), "utf8")), { count: 1 });
    getGenerativeAppCallbackBinding(result).assertCurrent();
  } finally { await rm(root, { recursive: true, force: true }); }
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
        assert.deepEqual({ generation: options.binding.generation, app: options.binding.app, revision: options.binding.revision }, {
          generation: options.binding.generation, app: "counter", revision: 0,
        });
        assert.equal(typeof options.binding.assertCurrent, "function"); options.binding.assertCurrent();
        return { markdown: `planned:${markdown}`, replyMarkup: { inline_keyboard: [] } };
      },
      async sendView(...args) {
        deliveries.push(args);
        return {
          ok: true as const,
          value: {
            target: { chatId: 123, threadId: 789 },
            messageIds: [654],
            generation: "delivery-1",
          },
        };
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
      {
        text: "planned:ready",
        parseMode: "markdown",
        replyMarkup: { inline_keyboard: [] },
      },
      {
        scope: { kind: "active-turn" },
        replyToMessageId: 456,
      },
    ]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telegram_bind attaches hinted successful delivery to the live-surface scheduler", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
  const timers: Array<() => void> = [];
  const edits: string[] = [];
  const pi = { registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI;
  try {
    const script = await writeApp(root, "dashboard", `
export function init() { return { state: {}, output: "initial", refreshAfterMs: 2000 }; }
export function refresh() { return { output: "updated" }; }
`);
    registerTelegramBindTool(pi, {
      agentDir,
      getActiveProfileName: () => "work",
      getActiveTurn: () => ({ chatId: 123, replyToMessageId: 456 }),
      isDeliveryHandleCurrent: () => true,
      planOutput: (markdown) => ({ markdown: `planned:${markdown}` }),
      sendView: async () => ({
        ok: true,
        value: { target: { chatId: 123 }, messageIds: [654], generation: "delivery-1" },
      }),
      editView: async (handle, view) => {
        edits.push(view.text);
        return { ok: true, value: handle };
      },
      liveSurfaceSetTimer(callback) {
        timers.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      liveSurfaceClearTimer: () => undefined,
    });
    await tool!.execute("call-1", { app: "dashboard", script });
    assert.equal(timers.length, 1);
    timers[0]!();
    for (let attempt = 0; attempt < 20 && edits.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(edits, ["planned:updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telegram_bind classifies Delivery message-unavailable live edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-generative-app-"));
  const agentDir = join(root, "agent");
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
  const timers: Array<() => void> = [];
  const outcomes: unknown[] = [];
  const pi = { registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI;
  try {
    const script = await writeApp(root, "missing-dashboard", `
export function init() { return { state: {}, output: "initial", refreshAfterMs: 2000 }; }
export function refresh() { return { output: "updated", refreshAfterMs: 3000 }; }
`);
    registerTelegramBindTool(pi, {
      agentDir,
      getActiveTurn: () => ({ chatId: 123, replyToMessageId: 456 }),
      isDeliveryHandleCurrent: () => true,
      planOutput: (markdown) => ({ markdown }),
      sendView: async () => ({
        ok: true,
        value: { target: { chatId: 123 }, messageIds: [654], generation: "delivery-1" },
      }),
      editView: async () => ({
        ok: false,
        reason: "message-unavailable",
        message: "message to edit not found",
      }),
      recordRuntimeEvent: (_category, _error, details) => outcomes.push(details?.outcome),
      liveSurfaceSetTimer(callback) {
        timers.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      liveSurfaceClearTimer: () => undefined,
    });
    await tool!.execute("call-1", { app: "missing-dashboard", script });
    timers[0]!();
    for (let attempt = 0; attempt < 20 && outcomes.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(outcomes, ["unavailable"]);
    assert.equal(timers.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telegram_bind live surfaces retain classic, leader, and follower delivery targets", async () => {
  const cases = [
    { name: "classic", ownsDirect: true, follower: false, active: { chatId: 123 } },
    { name: "leader", ownsDirect: true, follower: false, active: { chatId: 123, threadId: 7 } },
    { name: "follower", ownsDirect: false, follower: true, active: { chatId: 123, threadId: 8 } },
  ] as const;
  for (const entry of cases) {
    const root = await mkdtemp(join(tmpdir(), `pi-telegram-generative-app-${entry.name}-`));
    const agentDir = join(root, "agent");
    let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
    const timers: Array<() => void> = [];
    const sends: Array<Record<string, unknown>> = [];
    const edits: Array<Record<string, unknown>> = [];
    const policy = createTelegramDeliveryTargetPolicyRuntime({
      ownsDirect: () => entry.ownsDirect,
      isFollowerRegistered: () => entry.follower,
      getAllowedChatId: () => 123,
      getFollowerTarget: () => entry.follower ? entry.active : undefined,
      getLeaderTarget: () => entry.name === "leader" ? entry.active : undefined,
      listThreadRecords: () => "threadId" in entry.active ? [{ target: entry.active }] : [],
      getActiveTurnTarget: () => entry.active,
      getActiveGuestQueryId: () => undefined,
    });
    const runtime = createTelegramBridgeDeliveryRuntime({
      generation: `delivery-${entry.name}`,
      getTargetPolicyView: policy.getTargetPolicyView,
      getActiveTurnTarget: policy.getActiveTurnTarget,
      api: {
        async sendMessage(body) { sends.push(body); return { message_id: 654 }; },
        async editMessageText(body) { edits.push(body); return "edited"; },
        async deleteMessage() {},
        async sendChatAction() { return true; },
      },
      recordOwnership: () => undefined,
    });
    const unbind = bindTelegramDeliveryRuntime(runtime);
    try {
      const script = await writeApp(root, "dashboard", `
export function init() { return { state: {}, output: "initial", refreshAfterMs: 2000 }; }
export function refresh() { return { output: "updated" }; }
`);
      const pi = { registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI;
      registerTelegramBindTool(pi, {
        agentDir,
        getActiveProfileName: () => "work",
        getActiveTurn: () => ({
          chatId: entry.active.chatId,
          replyToMessageId: 456,
          target: entry.active,
        }),
        isDeliveryHandleCurrent: isTelegramDeliveryHandleCurrent,
        planOutput: (markdown) => ({ markdown }),
        sendView: (view, options) => sendTelegramView(
          view as Parameters<typeof sendTelegramView>[0],
          options,
        ),
        editView: (handle, view) => editTelegramView(
          handle,
          view as Parameters<typeof editTelegramView>[1],
        ),
        liveSurfaceSetTimer(callback) {
          timers.push(callback);
          return { unref() {} } as ReturnType<typeof setTimeout>;
        },
        liveSurfaceClearTimer: () => undefined,
      });
      await tool!.execute("call-1", { app: "dashboard", script });
      assert.equal(sends.length, 1, entry.name);
      assert.equal(sends[0]?.chat_id, entry.active.chatId, entry.name);
      assert.equal(
        sends[0]?.message_thread_id,
        "threadId" in entry.active ? entry.active.threadId : undefined,
        entry.name,
      );
      timers[0]!();
      for (let attempt = 0; attempt < 20 && edits.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(edits.length, 1, entry.name);
      assert.equal(edits[0]?.chat_id, entry.active.chatId, entry.name);
      assert.equal(edits[0]?.message_id, 654, entry.name);
    } finally {
      unbind();
      runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
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
