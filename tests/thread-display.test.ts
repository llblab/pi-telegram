/** Workspace display projection tests; no Telegram or TUI renderer is invoked. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramThreadDisplayReconciler,
  resolveTelegramInitialWorkspaceDisplayName,
  resolveTelegramWorkspaceDisplayNames,
} from "../lib/thread-display.ts";
import { createTelegramTopicTargetStore, createTelegramWorkspaceBindingIdentity } from "../lib/threads.ts";
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

test("Singleton directories hide the suffix until sticky exposure has been recorded", () => {
  assert.equal(resolveTelegramWorkspaceDisplayNames([bindings[0]], "directories").get("one"),
    "extensions");
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], showSlotSuffix: true },
  ], "directories").get("one"), "extensions_a");
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

test("Missing slots and ambiguous names do not fabricate a routable display identity", () => {
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], slot: undefined },
  ], "letters").size, 0);
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], slot: undefined, showSlotSuffix: true },
  ], "directories").size, 0);
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    bindings[0], { ...bindings[1], threadName: "Anchor" },
  ], "names").size, 0);
  assert.equal(resolveTelegramWorkspaceDisplayNames([
    { ...bindings[0], threadName: undefined },
  ], "names").get("one"), "A");
});

function harness() {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const identity = createTelegramWorkspaceBindingIdentity("/repo/extensions")!;
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
      return true as TResponse;
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
  const second = fixture.reconcile();
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ changed: 1 }, { changed: 0 }]);
  assert.deepEqual(fixture.state.calls, ["A"]);
});
