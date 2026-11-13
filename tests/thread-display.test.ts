/** Workspace display projection tests; no Telegram or TUI renderer is invoked. */
import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import {
  createTelegramThreadDisplayReconciler,
  createTelegramThreadDisplaySettingsRuntime,
  resolveTelegramInitialWorkspaceDisplayName,
  resolveTelegramWorkspaceDisplayNames,
  tokenizeTelegramDirectorySegment,
} from "../lib/thread-display.ts";
import { createTelegramTopicTargetStore, createTelegramWorkspaceBindingIdentity } from "../lib/threads.ts";
import { normalizeTelegramWorkspacePath } from "../lib/workspace-identity.ts";
import type { TelegramThreadDisplayMode } from "../lib/config.ts";
import type { TelegramApiCallOptions } from "../lib/telegram-api.ts";

const bindings = [
  { bindingKey: "one", cwd: "/repo/extensions", slot: "A", threadName: "Anchor" },
  { bindingKey: "two", cwd: "/repo/skills", slot: "B", threadName: "Briar" },
  { bindingKey: "three", cwd: "/repo/extensions", slot: "C", threadName: "Cedar" },
];

test("Three modes project the same stable bindings without changing named identity", () => {
  const before = structuredClone(bindings);
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(bindings, "letters").values()],
    ["A", "B", "C"]);
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(bindings, "names").values()],
    ["Anchor", "Briar", "Cedar"]);
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(bindings, "directories").values()],
    ["extensions_a", "skills", "extensions_c"]);
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(bindings, "names").values()],
    ["Anchor", "Briar", "Cedar"]);
  assert.deepEqual(bindings, before);
});

test("New directory modes share deterministic Unicode-aware tokenization and suffix projection", () => {
  assert.deepEqual(tokenizeTelegramDirectorySegment("apiPRDServer-42.tools"),
    ["api", "PRD", "Server", "42", "tools"]);
  const peers = [
    { ...bindings[0], cwd: "/repo/frontend/API tools" },
    { ...bindings[1], cwd: "/repo/backend/API tools" },
  ];
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(peers, "directory-snake").values()],
    ["frontend_api_tools", "backend_api_tools"]);
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(peers, "directory-title").values()],
    ["Frontend / API Tools", "Backend / API Tools"]);
  const sameDirectory = [
    { ...bindings[0], cwd: "/repo/apiPRDServer" },
    { ...bindings[2], cwd: "/repo/apiPRDServer" },
  ];
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(
    sameDirectory, "directory-title", new Set(["one", "three"]),
  ).values()], ["Api PRD Server A", "Api PRD Server C"]);
});

for (const platform of ["linux", "darwin", "win32"] as const) {
  for (const mode of ["directory-snake", "directory-title"] as const) {
    test(`Home display is an exact current-user Unix projection (${platform}, ${mode})`, () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      // Synchronous policy checks only; restore the host platform before any asynchronous/runtime work.
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      try {
        const home = normalizeTelegramWorkspacePath(homedir())!;
        const owner = { ...bindings[0], cwd: home };
        const expected = platform === "win32"
          ? resolveTelegramWorkspaceDisplayNames([{ ...owner, cwd: `/unrelated/${home.split("/").at(-1)}` }], mode).get("one")!
          : mode === "directory-title" ? "Home" : "home";
        assert.equal(resolveTelegramWorkspaceDisplayNames([owner], mode).get("one"), expected);
        assert.equal(resolveTelegramInitialWorkspaceDisplayName({ bindings: [], binding: owner, mode }), expected);
        const suffix = mode === "directory-title" ? " A" : "_a";
        const another = { ...bindings[2], cwd: home };
        const peers = [owner, another];
        const before = structuredClone(peers);
        assert.equal(resolveTelegramWorkspaceDisplayNames(peers, mode, new Set(["one", "three"])).get("one"), `${expected}${suffix}`);
        assert.equal(resolveTelegramWorkspaceDisplayNames(peers, mode, new Set(["one"])).get("one"), expected, "Dormant peers do not add suffixes");
        assert.equal(resolveTelegramInitialWorkspaceDisplayName({ bindings: [owner], binding: another, mode, liveBindingKeys: new Set(["one"]) }),
          `${expected}${mode === "directory-title" ? " C" : "_c"}`);
        assert.deepEqual(peers, before, "Home is only a display projection, never binding/CWD mutation");
        const manual = { ...owner, manualThreadName: "My Terminal" };
        for (const strategy of ["letters", "names", "directories", "directory-snake", "directory-title"] as const)
          assert.equal(resolveTelegramWorkspaceDisplayNames([manual], strategy).get("one"), "My Terminal");
        assert.equal(resolveTelegramWorkspaceDisplayNames([owner], "letters").get("one"), "A");
        assert.equal(resolveTelegramWorkspaceDisplayNames([owner], "names").get("one"), "Anchor");
        assert.equal(resolveTelegramWorkspaceDisplayNames([owner], "directories").get("one"), home.split("/").filter(Boolean).at(-1) ?? "/");
        for (const cwd of [`${home}/projects`, `${home}-other`, `/someone-else/${home.split("/").at(-1)}`]) {
          const foreign = { ...owner, cwd };
          const name = resolveTelegramWorkspaceDisplayNames([foreign], mode).get("one");
          const basename = cwd.split("/").filter(Boolean).at(-1)!;
          const normal = resolveTelegramWorkspaceDisplayNames([{ ...owner, cwd: `/display-reference/${basename}` }], mode).get("one");
          assert.equal(name, normal, "Children, path prefixes and another user's basename keep ordinary directory formatting");
        }
        if (platform !== "win32") {
          const live = new Set(["one", "two"]);
          const collision = [owner, { ...bindings[1], cwd: "/work/home" }];
          assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(collision, mode, live).values()],
            mode === "directory-title" ? ["Home", "Work / Home"] : ["home", "work_home"], "A real folder named home must remain distinguishable");
        }
      } finally { Object.defineProperty(process, "platform", descriptor); }
    });
  }
}

test("Manual names override every automatic display mode", () => {
  const overridden = { ...bindings[0], manualThreadName: "Navigator" };
  assert.equal(resolveTelegramWorkspaceDisplayNames(
    [overridden], "letters",
  ).get("one"), "Navigator");
  assert.equal(resolveTelegramWorkspaceDisplayNames(
    [overridden], "names",
  ).get("one"), "Navigator");
  assert.equal(resolveTelegramWorkspaceDisplayNames(
    [overridden], "directories",
  ).get("one"), "Navigator");
});

test("Home initial title and live reconciliation use the same projection without rebinding", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const home = normalizeTelegramWorkspacePath(homedir())!;
  const f = harness(home);
  f.state.mode = "directory-title";
  const before = structuredClone(f.store.listWorkspaceBindings());
  assert.equal(resolveTelegramInitialWorkspaceDisplayName({ bindings: [], binding: before[0]!, mode: "directory-title" }), "Home");
  assert.deepEqual(await f.reconcile(), { changed: 1 });
  assert.deepEqual(f.state.calls, ["Home"]);
  const changed = f.store.listWorkspaceBindings()[0]!;
  assert.deepEqual(changed, { ...before[0], displayTitle: "Home" });
  f.state.mode = "directory-snake";
  assert.deepEqual(await f.reconcile(), { changed: 1 });
  assert.deepEqual(f.state.calls, ["Home", "home"]);
  assert.deepEqual(f.store.listWorkspaceBindings()[0], { ...before[0], displayTitle: "home" });
});

test("Initial titles project the candidate before Telegram creates the Thread", () => {
  assert.equal(resolveTelegramInitialWorkspaceDisplayName({
    bindings: [], binding: bindings[0], mode: "directories",
  }), "extensions");
  assert.equal(resolveTelegramInitialWorkspaceDisplayName({
    bindings: [bindings[0]], binding: bindings[2], mode: "directories",
  }), "extensions_c");
  assert.equal(resolveTelegramInitialWorkspaceDisplayName({
    bindings: [], binding: bindings[0], mode: "letters",
  }), "A");
  assert.equal(resolveTelegramInitialWorkspaceDisplayName({
    bindings: [{ ...bindings[0], showSlotSuffix: true }],
    binding: { ...bindings[0], threadName: "Aster" },
    mode: "directories",
  }), "extensions_a");
  assert.equal(resolveTelegramInitialWorkspaceDisplayName({
    bindings: [{ ...bindings[0], manualThreadName: "wasd_123!?+$@" }],
    binding: { ...bindings[0], threadName: "Aster" },
    mode: "letters",
  }), "wasd_123!?+$@");
});

test("Legacy suffixes remain sticky while new directory modes use only live ownership", () => {
  assert.equal(resolveTelegramWorkspaceDisplayNames([bindings[0]], "directories").get("one"),
    "extensions");
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], showSlotSuffix: true },
  ], "directories").get("one"), "extensions_a");
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], showSlotSuffix: true },
  ], "directory-title").get("one"), "Extensions");
  const sameDirectory = [bindings[0], bindings[2]];
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(
    sameDirectory, "directory-snake", new Set(["one"]),
  ).values()], ["extensions", "extensions"]);
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(
    sameDirectory, "directory-snake", new Set(["one", "three"]),
  ).values()], ["extensions_a", "extensions_c"]);
});

test("Equal basenames from distinct paths use the shortest distinguishing parent suffix", () => {
  const peers = [
    { ...bindings[0], cwd: "/repo/frontend/extensions" },
    { ...bindings[1], cwd: "/repo/backend/extensions" },
  ];
  assert.deepEqual([...resolveTelegramWorkspaceDisplayNames(peers, "directories").values()],
    ["frontend/extensions", "backend/extensions"]);
});

test("Directory labels are bounded without splitting surrogate pairs or losing slot suffixes", () => {
  const peers = bindings.slice(0, 2).map((binding, index) => ({
    ...binding, cwd: `/repo/${"😀".repeat(100)}${index}`,
  }));
  const labels = [...resolveTelegramWorkspaceDisplayNames(peers, "directories").values()];
  assert.equal(labels.length, 2);
  assert.notEqual(labels[0], labels[1]);
  for (const label of labels) {
    assert.ok(label.length <= 128);
    assert.ok(label.isWellFormed());
    assert.match(label, /_[ab]$/u);
  }
});

test("Slotless bindings use their retained name rather than an obsolete letter or suffix", () => {
  for (const mode of ["letters", "names", "directories", "directory-snake", "directory-title"] as const) {
    assert.equal(resolveTelegramWorkspaceDisplayNames([
      { ...bindings[0], slot: undefined, showSlotSuffix: true },
    ], mode).get("one"), "Anchor", mode);
    assert.equal(resolveTelegramWorkspaceDisplayNames([
      { ...bindings[0], slot: undefined, manualThreadName: "Custom" },
    ], mode).get("one"), "Custom", mode);
  }
});

test("Missing display identity and ambiguous names never fabricate a label", () => {
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], slot: undefined, threadName: undefined },
  ], "letters").size, 0);
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    bindings[0], { ...bindings[1], threadName: "Anchor" },
  ], "names").size, 0);
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], threadName: undefined },
  ], "names").get("one"), "A");
});

function harness(cwd = "/repo/extensions") {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const identity = createTelegramWorkspaceBindingIdentity(cwd)!;
  store.upsertWorkspaceBinding({
    ...identity, target: { chatId: 7, threadId: 42 }, slot: "A",
    threadName: "Anchor", updatedAtMs: 1,
  });
  const state = {
    mode: "letters" as TelegramThreadDisplayMode,
    profile: "default",
    epoch: 1 as number | undefined,
    active: true,
    registrationGeneration: 1,
    persistFailure: false,
    editResult: true as unknown,
    persists: 0,
    calls: [] as string[],
    onEdit: undefined as (() => Promise<void>) | undefined,
  };
  const reconciler = createTelegramThreadDisplayReconciler({
    store: {
      listWorkspaceBindings: store.listWorkspaceBindings,
      setWorkspaceDisplayTitle: store.setWorkspaceDisplayTitle,
      async persist() {
        state.persists++;
        if (state.persistFailure) throw new Error("disk unavailable");
      },
    },
    getMode: () => state.mode,
    getProfileKey: () => state.profile,
    getLeaderEpoch: () => state.epoch,
    captureLiveBindingKeys(currentBindings) {
      return new Set(state.active ? currentBindings.map((binding) => binding.bindingKey) : []);
    },
    captureBindingAuthority() {
      if (!state.active) return undefined;
      const generation = state.registrationGeneration;
      return () => state.active && state.registrationGeneration === generation;
    },
    async callApi<TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) {
      assert.equal(method, "editForumTopic");
      assert.equal(body.chat_id, 7);
      assert.equal(body.message_thread_id, 42);
      assert.equal(options?.maxAttempts, 1);
      state.calls.push(String(body.name));
      await state.onEdit?.();
      return state.editResult as TResponse;
    },
  });
  return { store, state, ...reconciler };
}

test("Display changes preserve named identity, slot, and target across all modes", async () => {
  const fixture = harness();
  for (const mode of ["letters", "directories", "names"] as const) {
    fixture.state.mode = mode;
    assert.deepEqual(await fixture.reconcile(), { changed: 1 });
  }
  assert.deepEqual(fixture.state.calls, ["A", "extensions", "Anchor"]);
  assert.deepEqual(await fixture.reconcile(), { changed: 0 });
  const binding = fixture.store.listWorkspaceBindings()[0];
  assert.equal(binding.threadName, "Anchor");
  assert.equal(binding.displayTitle, "Anchor");
  assert.equal(binding.slot, "A");
  assert.deepEqual(binding.target, { chatId: 7, threadId: 42 });
  assert.equal(fixture.state.calls.length, 3);
});

test("No direct owner and dormant bindings cannot cause title edits", async () => {
  const fixture = harness();
  fixture.state.epoch = undefined;
  await assert.rejects(fixture.reconcile(), /authority/);
  fixture.state.epoch = 1;
  fixture.state.active = false;
  assert.deepEqual(await fixture.reconcile(), { changed: 0 });
  assert.deepEqual(fixture.state.calls, []);
});

test("Late ACKs cannot commit across profile, mode, epoch, binding, or active-owner changes", async () => {
  for (const change of ["profile", "mode", "epoch", "binding", "owner", "registration"] as const) {
    const fixture = harness();
    fixture.state.onEdit = async () => {
      if (change === "profile") fixture.state.profile = "other";
      if (change === "mode") fixture.state.mode = "directories";
      if (change === "epoch") fixture.state.epoch = 2;
      if (change === "owner") fixture.state.active = false;
      if (change === "registration") fixture.state.registrationGeneration++;
      if (change === "binding") {
        fixture.store.upsertWorkspaceBinding({
          ...fixture.store.listWorkspaceBindings()[0],
          target: { chatId: 7, threadId: 43 }, updatedAtMs: 2,
        });
      }
    };
    await assert.rejects(fixture.reconcile(), /authority|binding changed/);
    assert.equal(fixture.store.listWorkspaceBindings()[0].displayTitle, undefined, change);
    assert.equal(fixture.state.persists, 0, change);
  }
});

test("Rejected or unknown edits retain prior title evidence without claiming success", async () => {
  const fixture = harness();
  fixture.state.onEdit = async () => { throw new Error("ACK unknown"); };
  await assert.rejects(fixture.reconcile(), /ACK unknown/);
  assert.equal(fixture.store.listWorkspaceBindings()[0].displayTitle, undefined);
  assert.equal(fixture.state.persists, 0);
});

test("Only a positive title acknowledgement can replace stored display evidence", async () => {
  for (const result of [false, undefined, null, {}, "true"]) {
    const fixture = harness();
    fixture.state.editResult = result;
    await assert.rejects(fixture.reconcile(), /not acknowledged/);
    assert.equal(fixture.store.listWorkspaceBindings()[0].displayTitle, undefined);
    assert.equal(fixture.state.persists, 0);
  }
});

test("Failed persistence retries acknowledged metadata without another Telegram edit", async () => {
  const fixture = harness();
  fixture.state.persistFailure = true;
  await assert.rejects(fixture.reconcile(), /disk unavailable/);
  assert.equal(fixture.store.listWorkspaceBindings()[0].displayTitle, "A");
  fixture.state.persistFailure = false;
  assert.deepEqual(await fixture.reconcile(), { changed: 0 });
  assert.deepEqual(fixture.state.calls, ["A"]);
  assert.equal(fixture.state.persists, 2);
});

test("Concurrent reconciliation is serialized and uses the committed title", async () => {
  const fixture = harness();
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  fixture.state.onEdit = async () => { started(); await pending; };
  const first = fixture.reconcile();
  await entered;
  const second = fixture.reconcileLive();
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ changed: 1 }, { changed: 0 }]);
  assert.deepEqual(fixture.state.calls, ["A"]);
});

test("A targeted slotless reconciliation does not edit unrelated live bindings", async () => {
  const fixture = harness();
  const original = fixture.store.listWorkspaceBindings()[0]!;
  fixture.store.upsertWorkspaceBinding({ ...original, slot: undefined, displayTitle: "A" });
  const other = createTelegramWorkspaceBindingIdentity("/repo/other")!;
  fixture.store.upsertWorkspaceBinding({ ...other, target: { chatId: 7, threadId: 43 }, slot: "B", threadName: "Briar", displayTitle: "old", updatedAtMs: 1 });
  assert.deepEqual(await fixture.reconcile(original.bindingKey), { changed: 1 });
  assert.deepEqual(fixture.state.calls, ["Anchor"]);
  assert.equal(fixture.store.listWorkspaceBindings().find(binding => binding.bindingKey === other.bindingKey)?.displayTitle, "old");
  assert.deepEqual(await fixture.reconcile(original.bindingKey), { changed: 0 });
});

test("Thread display settings owner clears a retained manual override after mode application", async () => {
  const target = { chatId: 7, threadId: 42 };
  const calls: string[] = [];
  let manualThreadName: string | undefined = "Custom";
  const runtime = createTelegramThreadDisplaySettingsRuntime({
    getTarget: () => target,
    getBinding: () => ({ manualThreadName }),
    apply: async (mode) => { calls.push(`apply:${mode}`); },
    reset: async () => { calls.push("reset"); manualThreadName = undefined; return { ok: true }; },
  });
  assert.equal(runtime.isCustom(), true);
  await runtime.setMode("names");
  assert.deepEqual(calls, ["apply:names", "reset"]);
  assert.equal(runtime.isCustom(), false);
});
