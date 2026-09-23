/**
 * Workspace retirement preparation tests
 * Zones: telegram, workspace identity, lifecycle
 * Mirrors lib/workspace-retirement.ts and excludes live Telegram deletion.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramTopicTargetStore,
  createTelegramWorkspaceBindingIdentity,
  type TelegramWorkspaceExternalProtectionEvidence,
  type TelegramWorkspaceThreadBinding,
} from "../lib/threads.ts";
import {
  adoptTelegramWorkspaceRetirementIntent,
  captureTelegramWorkspaceExternalProtection,
  captureTelegramWorkspaceJournalProtectionSources,
  createTelegramWorkspaceDeadOwnerQueueReclaimer,
  createTelegramWorkspaceExternalProtectionCapture,
  createTelegramWorkspaceOperationGate,
  createTelegramWorkspaceOperationRuntime,
  createTelegramWorkspaceSlotRotation,
  executeTelegramWorkspaceRetirement,
  prepareTelegramWorkspaceRetirement,
  pruneTelegramWorkspaceJournalEvidence,
  resolveTelegramWorkspaceAcceptedWorkProtection,
  runTelegramWorkspaceRetirementLifecycle,
} from "../lib/workspace-retirement.ts";
import {
  createDefaultTelegramBridgeApiRuntime,
  setTelegramApiHttpsFetchForTesting,
  TelegramApiStaleTargetError,
} from "../lib/telegram-api.ts";
import { TelegramWorkspaceSlotUnavailableError } from "../lib/workspace-slots.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import {
  createTelegramUpdateJournalBotIdentity,
  createTelegramUpdateJournalStore,
  inspectTelegramUpdateJournalFamily,
  type TelegramUpdateJournalEntry,
} from "../lib/journal.ts";

const clearExternalProtection = () => ({
  liveOwner: "clear" as const,
  acceptedWork: "clear" as const,
  deliveryAuthority: "clear" as const,
});

function createRetirementAdmission(path: string, owner = "executor") {
  return createTelegramWorkspaceAdmissionLedger({
    path,
    profileKey: "default",
    owner: {
      processId: process.pid,
      processBirthId: `${process.pid}:retirement-${owner}`,
    },
    getProcessLiveness: () => "alive",
  });
}

function addBinding(
  store: ReturnType<typeof createTelegramTopicTargetStore>,
  index: number,
  inactiveSinceMs: number,
  sessionId?: string,
): void {
  const slot = String.fromCharCode("A".charCodeAt(0) + index);
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity(
      `/repo/${index}`, 0, sessionId)!,
    target: { chatId: 7, threadId: 40 + index },
    slot,
    threadName: `Workspace${index}`,
    inactiveSinceMs,
    updatedAtMs: 100,
  });
}

test("Workspace operation gate serializes effects and recovers after failure", async () => {
  const gate = createTelegramWorkspaceOperationGate();
  const events: string[] = [];
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const first = gate.runExclusive(async () => {
    events.push("first:start");
    await blocker;
    events.push("first:end");
  });
  const second = gate.runExclusive(async () => { events.push("second"); throw new Error("fixture"); });
  const third = gate.runExclusive(async () => { events.push("third"); return 3; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["first:start"]);
  release?.();
  await first;
  await assert.rejects(second, /fixture/);
  assert.equal(await third, 3);
  assert.deepEqual(events, ["first:start", "first:end", "second", "third"]);
});

test("Journal evidence enumeration reads shared and historical follower journals and preserves incomplete legacy state", () => {
  const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2,
    journalBindingKeys: ["manual:old", "manual:new"], journalBindingsComplete: true as const };
  const entries = new Map<string, Array<{ update: unknown }>>([
    ["leader", [{ update: { message: { chat: { id: 7 }, message_thread_id: 41 } } }]],
    ["manual:old", []],
    ["manual:new", [{ update: { undecodable: true } }]],
  ]);
  const references: string[] = [];
  const capture = (candidate: TelegramWorkspaceThreadBinding) => captureTelegramWorkspaceJournalProtectionSources({
    binding: candidate,
    resolveLeader: () => ({ recoveryKey: "leader",
      journal: { read: () => ({ entries: entries.get("leader")! }) } }),
    createFollowerResolver: (key) => () => ({ recoveryKey: key,
      journal: { read: () => ({ entries: entries.get(key)! }) } }),
    withJournalReference(binding, operation) {
      references.push(`acquire:${binding.recoveryKey}`);
      try { return operation(); } finally { references.push(`release:${binding.recoveryKey}`); }
    },
  });
  const complete = capture(binding);
  assert.deepEqual(references, ["acquire:leader", "release:leader",
    "acquire:manual:old", "release:manual:old",
    "acquire:manual:new", "release:manual:new"]);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.sources.map((source) => source.scope), [
    { kind: "shared" },
    { kind: "binding", bindingKey: binding.bindingKey, journalBindingKey: "manual:old" },
    { kind: "binding", bindingKey: binding.bindingKey, journalBindingKey: "manual:new" },
  ]);
  assert.equal(resolveTelegramWorkspaceAcceptedWorkProtection({ binding,
    localAcceptedTargets: [], journalSources: complete.sources,
    sourcesComplete: complete.complete }), "protected");
  assert.equal(capture({ ...binding, journalBindingsComplete: undefined }).complete, false);
  const legacy = captureTelegramWorkspaceJournalProtectionSources({
    binding: { ...binding, journalBindingsComplete: undefined },
    resolveLeader: () => ({ journal: { read: () => ({ entries: [] }) } }),
    createFollowerResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }),
    discovery: {
      paths: ["/journals/follower-inbox-legacy.json"], complete: true,
      createResolver: () => () => ({ journal: { read: () => ({ entries: [{ update: {
        message: { chat: { id: 7 }, message_thread_id: 42 },
      } }] }) } }),
    },
  });
  assert.equal(legacy.complete, true);
  assert.deepEqual(legacy.sources.at(-1)?.scope,
    { kind: "discovered", path: "/journals/follower-inbox-legacy.json" });
  assert.equal(resolveTelegramWorkspaceAcceptedWorkProtection({ binding,
    localAcceptedTargets: [], journalSources: legacy.sources,
    sourcesComplete: legacy.complete }), "protected");
  const unreadable = captureTelegramWorkspaceJournalProtectionSources({
    binding,
    resolveLeader: () => { throw new Error("journal unavailable"); },
    createFollowerResolver: () => () => undefined,
  });
  assert.equal(unreadable.complete, false);
  assert.ok(unreadable.sources.every((source) => source.kind === "unknown"));
});

test("Journal pruning removes only proven-empty known keys under exact profile and leader authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-journal-prune-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 500 });
    const admission = createRetirementAdmission(
      join(dir, "workspace-admission.json"),
      "journal-prune",
    );
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2,
      journalBindingKeys: ["manual:empty", "manual:busy"], journalBindingsComplete: true as const };
    store.upsertWorkspaceBinding(binding);
    const capture = captureTelegramWorkspaceJournalProtectionSources({
      binding,
      resolveLeader: () => ({ journal: { read: () => ({ entries: [] }) } }),
      createFollowerResolver: (key) => () => ({ journal: { read: () => ({
        entries: key === "manual:busy" ? [{ update: { undecodable: true } }] : [],
      }) } }),
    });
    const fence = admission.acquireRetirementFence({
      operationId: "journal-prune-fence",
      retirementIntentId: "journal-prune-intent",
      bindingKey: binding.bindingKey,
      slot: "A",
      target: binding.target,
      leaderEpoch: 1,
      retirementRequestedAtMs: 1,
    });
    assert.equal(fence.kind, "acquired");
    await assert.rejects(
      pruneTelegramWorkspaceJournalEvidence({
        store, binding, capture, admission,
        getJournalWriterProtection: () => "clear",
        getLeaderEpoch: () => 1, getProfileKey: () => "default",
      }),
      /blocked by retirement/u,
    );
    assert.deepEqual(
      store.getWorkspaceBinding("/repo")?.journalBindingKeys,
      ["manual:empty", "manual:busy"],
    );
    if (fence.kind === "acquired") {
      admission.releaseUnissuedRetirementFence(fence.fence);
    }
    assert.deepEqual(await pruneTelegramWorkspaceJournalEvidence({
      store, binding, capture, admission,
      getJournalWriterProtection: () => "unknown",
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
    }), { kind: "blocked", reason: "writer-not-quiescent" });
    assert.deepEqual(store.getWorkspaceBinding("/repo")?.journalBindingKeys,
      ["manual:empty", "manual:busy"]);
    const result = await pruneTelegramWorkspaceJournalEvidence({
      store, binding, capture, admission,
      getJournalWriterProtection: () => "clear",
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
    });
    assert.equal(result.kind, "committed");
    if (result.kind !== "committed") return;
    assert.deepEqual(result.removedKeys, ["manual:empty"]);
    assert.deepEqual(result.binding.journalBindingKeys, ["manual:busy"]);
    assert.equal(result.binding.updatedAtMs, 500);
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.deepEqual(restored.getWorkspaceBinding("/repo")?.journalBindingKeys, ["manual:busy"]);
    const legacy = { ...createTelegramWorkspaceBindingIdentity("/legacy")!,
      target: { chatId: 7, threadId: 43 }, slot: "B", inactiveSinceMs: 1, updatedAtMs: 2,
      journalBindingKeys: ["manual:known"] };
    store.upsertWorkspaceBinding(legacy);
    const incomplete = captureTelegramWorkspaceJournalProtectionSources({
      binding: legacy,
      resolveLeader: () => ({ journal: { read: () => ({ entries: [] }) } }),
      createFollowerResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }),
    });
    assert.deepEqual(await pruneTelegramWorkspaceJournalEvidence({
      store, binding: legacy, capture: incomplete, admission,
      getJournalWriterProtection: () => "clear",
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
    }), { kind: "blocked", reason: "incomplete-evidence" });
    const discovered = captureTelegramWorkspaceJournalProtectionSources({
      binding: legacy,
      resolveLeader: () => ({ journal: { read: () => ({ entries: [] }) } }),
      createFollowerResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }),
      discovery: { paths: ["/legacy/follower.json"], complete: true,
        createResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }) },
    });
    const legacyPrune = await pruneTelegramWorkspaceJournalEvidence({
      store, binding: legacy, capture: discovered, admission,
      getJournalWriterProtection: () => "clear",
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
    });
    assert.equal(legacyPrune.kind, "committed");
    assert.equal(store.getWorkspaceBinding("/legacy")?.journalBindingKeys, undefined);
    assert.equal(store.getWorkspaceBinding("/legacy")?.journalBindingsComplete, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Journal pruning admission spans durable binding publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-journal-prune-admission-"));
  const admission = createRetirementAdmission(
    join(dir, "workspace-admission.json"),
    "journal-prune-publication",
  );
  const binding = {
    ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 7, threadId: 42 },
    slot: "A",
    inactiveSinceMs: 1,
    updatedAtMs: 2,
    journalBindingKeys: ["manual:empty"],
    journalBindingsComplete: true as const,
  };
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pruning = pruneTelegramWorkspaceJournalEvidence({
    store: {
      commitWorkspaceJournalEvidence(expected, journalBindingKeys, complete) {
        return {
          ...expected,
          journalBindingKeys: [...journalBindingKeys],
          journalBindingsComplete: complete ? true : undefined,
        };
      },
      async persist() {
        entered?.();
        await held;
      },
    },
    binding,
    capture: {
      complete: true,
      sources: [
        { kind: "available", scope: { kind: "shared" }, entries: [] },
        {
          kind: "available",
          scope: {
            kind: "binding",
            bindingKey: binding.bindingKey,
            journalBindingKey: "manual:empty",
          },
          entries: [],
        },
      ],
    },
    admission,
    getJournalWriterProtection: () => "clear",
    getLeaderEpoch: () => 1,
    getProfileKey: () => "default",
  });
  try {
    await started;
    assert.deepEqual(
      admission.acquireRetirementFence({
        operationId: "journal-prune-racing-fence",
        retirementIntentId: "journal-prune-racing-intent",
        bindingKey: binding.bindingKey,
        slot: "A",
        target: binding.target,
        leaderEpoch: 1,
        retirementRequestedAtMs: 1,
      }),
      { kind: "blocked", reason: "admission-active" },
    );
    release?.();
    const result = await pruning;
    assert.equal(result.kind, "committed");
    assert.deepEqual(admission.read().leases, []);
  } finally {
    release?.();
    await pruning.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Accepted-work evidence protects exact local and journal targets and fails closed on incomplete sources", () => {
  const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 7, threadId: 42 }, slot: "A", threadName: "Anchor",
    inactiveSinceMs: 1, updatedAtMs: 2 };
  const resolve = (overrides: Partial<Parameters<typeof resolveTelegramWorkspaceAcceptedWorkProtection>[0]> = {}) =>
    resolveTelegramWorkspaceAcceptedWorkProtection({
      binding, localAcceptedTargets: [], journalSources: [], sourcesComplete: true,
      ...overrides,
    });
  assert.equal(resolve(), "clear");
  assert.equal(resolve({ localAcceptedTargets: [{ chatId: 7, threadId: 42 }] }), "protected");
  assert.equal(resolve({ localAcceptedTargets: [{ chatId: 7, threadId: 43 }] }), "clear");
  assert.equal(resolve({ journalSources: [{ kind: "available",
    scope: { kind: "binding", bindingKey: binding.bindingKey, journalBindingKey: "manual:current" },
    entries: [{ update: { undecodable: true } }] }] }), "protected");
  assert.equal(resolve({ journalSources: [{ kind: "available", scope: { kind: "shared" },
    entries: [{ update: { message: { chat: { id: 7 }, message_thread_id: 42 } } }] }] }), "protected");
  assert.equal(resolve({ journalSources: [{ kind: "available", scope: { kind: "shared" },
    entries: [{ update: { callback_query: { message: { chat: { id: 7 }, message_thread_id: 43 } } } }] }] }), "clear");
  assert.equal(resolve({ journalSources: [{ kind: "available", scope: { kind: "shared" },
    entries: [{ update: { message_reaction: { chat: { id: 7 }, message_id: 5 } } }] }] }), "unknown");
  assert.equal(resolve({ journalSources: [{ kind: "unknown", scope: { kind: "shared" } }] }), "unknown");
  assert.equal(resolve({ sourcesComplete: false }), "unknown");
  assert.equal(resolve({ journalSources: [{ kind: "unknown",
    scope: { kind: "binding", bindingKey: "other", journalBindingKey: "manual:other" } }] }), "clear");
});

test("External protection composition keeps incomplete queues, journals, registries, and delivery unknown", () => {
  const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2,
    journalBindingKeys: [], journalBindingsComplete: true as const };
  const capture = (overrides: Partial<Parameters<typeof captureTelegramWorkspaceExternalProtection>[0]> = {}) =>
    captureTelegramWorkspaceExternalProtection({
      binding,
      getLiveOwnerProtection: () => "clear",
      getLocalAcceptedTargets: () => ({ targets: [], complete: true }),
      captureJournalSources: () => ({ sources: [], complete: true }),
      ...overrides,
    });
  assert.deepEqual(capture(), { liveOwner: "clear", acceptedWork: "clear",
    deliveryAuthority: "unknown" });
  assert.equal(capture({ getDeliveryAuthorityProtection: () => "clear" })
    .deliveryAuthority, "clear");
  assert.equal(capture({ getDeliveryAuthorityProtection: () => "protected" })
    .deliveryAuthority, "protected");
  assert.equal(capture({ getLocalAcceptedTargets: () => ({
    targets: [binding.target], complete: false,
  }) }).acceptedWork, "protected");
  assert.equal(capture({ getLocalAcceptedTargets: () => ({
    targets: [], complete: false,
  }) }).acceptedWork, "unknown");
  assert.deepEqual(capture({
    getLiveOwnerProtection: () => { throw new Error("registry unavailable"); },
    captureJournalSources: () => { throw new Error("journal unavailable"); },
    getDeliveryAuthorityProtection: () => { throw new Error("delivery unavailable"); },
  }), { liveOwner: "unknown", acceptedWork: "unknown", deliveryAuthority: "unknown" });
  let discoveries = 0;
  const assembled = createTelegramWorkspaceExternalProtectionCapture({
    listFollowers: () => [{ target: binding.target }],
    getActiveTurnTarget: () => undefined,
    getQueuedItems: () => [{ chatId: 7 }],
    resolveLeaderJournal: () => ({ journal: { read: () => ({ entries: [] }) } }),
    createFollowerJournalResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }),
    discoverFollowerJournals: () => { discoveries++; return { paths: [], complete: true }; },
    createJournalPathResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }),
  });
  assert.deepEqual(assembled(binding), { liveOwner: "protected", acceptedWork: "unknown",
    deliveryAuthority: "unknown" });
  assert.equal(discoveries, 0);
  assembled({ ...binding, journalBindingsComplete: undefined });
  assert.equal(discoveries, 1);
  const writerAware = createTelegramWorkspaceExternalProtectionCapture({
    listFollowers: () => [], getActiveTurnTarget: () => undefined,
    getQueuedItems: () => [],
    resolveLeaderJournal: () => ({ journal: { read: () => ({ entries: [] }) } }),
    createFollowerJournalResolver: () => () => ({ journal: { read: () => ({ entries: [] }) } }),
    getJournalWriterProtection: (key) => key === "live" ? "protected" : "clear",
  });
  assert.equal(writerAware({ ...binding, journalBindingKeys: ["dead"] }).liveOwner, "clear");
  assert.equal(writerAware({ ...binding, journalBindingKeys: ["live"] }).liveOwner, "protected");
  assert.equal(writerAware({ ...binding, journalBindingsComplete: undefined }).liveOwner, "unknown");
});

test("Successor leader adopts only the exact protected intent and persistence failure retains the old epoch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-adoption-"));
  const path = join(dir, "state.json");
  const admission = createRetirementAdmission(join(dir, "admission.json"), "successor");
  let canCommit = true;
  try {
    const store = createTelegramTopicTargetStore({ path, commitPersist(commit) {
      if (!canCommit) return false;
      commit();
      return true;
    } });
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:a", reason: "pressure" as const, profileKey: "default",
      binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    await store.persist();
    const base = {
      store, intent, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 2, getProfileKey: () => "default",
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    };
    canCommit = false;
    await assert.rejects(adoptTelegramWorkspaceRetirementIntent(base),
      /lost exact transport ownership/);
    assert.deepEqual(store.listWorkspaceRetirementIntents(), [intent]);
    canCommit = true;
    const adopted = await adoptTelegramWorkspaceRetirementIntent(base);
    assert.equal(adopted.kind, "adopted");
    if (adopted.kind !== "adopted") return;
    assert.equal(adopted.intent.leaderEpoch, 2);
    assert.equal(adopted.intent.requestedAtMs, 3);
    assert.deepEqual(await adoptTelegramWorkspaceRetirementIntent({ ...base,
      intent: adopted.intent, getProfileKey: () => "other",
    }), { kind: "blocked", reason: "profile-changed" });
    assert.deepEqual(await executeTelegramWorkspaceRetirement({
      store, intent, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 2, getProfileKey: () => "default", admission,
      runExclusive: base.runExclusive, async deleteForumTopic() { throw new Error("must not delete old epoch"); },
    }), { kind: "retained", reason: "authority-changed" });
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.deepEqual(restored.listWorkspaceRetirementIntents(), [adopted.intent]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Explicit lifecycle prepares and executes one pressure retirement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-lifecycle-"));
  try {
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    for (let index = 0; index < 26; index++) addBinding(store, index, index + 1);
    const binding = store.getWorkspaceBinding("/repo/0")!;
    let gates = 0;
    let deletions = 0;
    const run = () => runTelegramWorkspaceRetirementLifecycle({
      store, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
      getNowMs: () => 1000,
      runExclusive: async <T>(operation: () => Promise<T>) => { gates++; return operation(); },
      admission,
      async deleteForumTopic(permit, body, options) {
        deletions++;
        assert.equal(permit.slot, "A");
        assert.deepEqual(body, { chat_id: 7, message_thread_id: 40 });
        assert.deepEqual(options, { maxAttempts: 1 });
      },
    });
    assert.deepEqual(await run(), { kind: "retired", bindingKey: binding.bindingKey, slot: "A" });
    assert.equal(gates, 1);
    assert.equal(deletions, 1);
    assert.deepEqual(await run(), { kind: "not-needed", reason: "free-capacity" });
    assert.equal(gates, 1);
    assert.equal(deletions, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pressure rotation reclaims exact queued custody only after native dead-owner proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-dead-owner-reclamation-"));
  try {
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"),
      getExternalReservedSlots: admission.listReservedSlots });
    for (let index = 0; index < 26; index++) addBinding(store, index, index + 1);
    const initial = store.getWorkspaceBinding("/repo/0")!;
    const journalBindingKey = "manual-follower:dead-fixture";
    assert.ok(store.commitWorkspaceJournalEvidence(initial, [journalBindingKey], true));
    await store.persist();

    const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "7:fixture" });
    const recoveryOwner = { instanceId: "leader", processId: process.pid,
      processBirthId: `${process.pid}:leader`, sessionGeneration: 2 };
    const deadOwner = { instanceId: "dead-follower",
      processId: process.pid + 1_000_000, processBirthId: `${process.pid + 1_000_000}:dead`,
      sessionGeneration: 1 };
    const createJournal = (name: string, queueRuntimeIdentity = recoveryOwner) => {
      const path = join(dir, name);
      const journal = createTelegramUpdateJournalStore({ path, profileName: "default", botIdentity,
        queueRuntimeIdentity, workspaceAdmission: admission,
        getQueueProcessLiveness: owner => owner.processId === deadOwner.processId ? "dead" : "alive" });
      return { recoveryKey: path, journal, readForProtection: () => {
        const evidence = inspectTelegramUpdateJournalFamily({ directory: dir, path,
          profile: "default", botIdentity,
          limits: { maxFiles: 128, maxBytes: 1_000_000, maxEntries: 128, maxWork: 10_000 } });
        if (evidence.kind !== "present") throw new Error("fixture journal disappeared");
        return { entries: evidence.file.entries };
      } };
    };
    const leader = createJournal("inbox.json");
    leader.journal.appendBatch([{ update_id: 99, message: { message_id: 99,
      chat: { id: 999, type: "private" }, from: { id: 7, is_bot: false }, text: "seed" } }], 99);
    const seeded = leader.journal.markQueued({ queueKind: "prompt", receiptId: "seed-receipt",
      sourceUpdateIds: [99], owner: recoveryOwner });
    assert.ok(seeded.queueOwner);
    leader.journal.completeQueued([{ queueKind: "prompt", receiptId: "seed-receipt",
      sourceUpdateIds: [99], queueOwner: seeded.queueOwner! }]);
    const deadWriter = createJournal("follower-inbox-dead000000000000.json", deadOwner);
    deadWriter.journal.appendBatch([{ update_id: 1, message: { message_id: 10,
      message_thread_id: initial.target.threadId, chat: { id: initial.target.chatId, type: "private" },
      from: { id: 7, is_bot: false }, text: "retained dead-owner work" } }], 1);
    deadWriter.journal.markQueued({ queueKind: "prompt", receiptId: "dead-receipt",
      sourceUpdateIds: [1], owner: deadOwner });
    const follower = createJournal("follower-inbox-dead000000000000.json");

    const capture = createTelegramWorkspaceExternalProtectionCapture({
      listFollowers: () => [], getActiveTurnTarget: () => undefined, getQueuedItems: () => [],
      resolveLeaderJournal: () => leader,
      createFollowerJournalResolver: key => () => key === journalBindingKey ? follower : undefined,
      getJournalWriterProtection: () => "clear", getDeliveryAuthorityProtection: () => "clear",
    });
    const getProtection = (binding: TelegramWorkspaceThreadBinding): TelegramWorkspaceExternalProtectionEvidence =>
      binding.bindingKey === initial.bindingKey ? capture(binding) : {
        liveOwner: "protected", acceptedWork: "clear", deliveryAuthority: "clear",
      };
    const reclaim = createTelegramWorkspaceDeadOwnerQueueReclaimer({
      getExternalProtection: getProtection, getActiveTurnTarget: () => undefined,
      getQueuedItems: () => [], resolveLeaderJournal: () => leader,
      createFollowerJournalResolver: key => () => key === journalBindingKey ? follower : undefined,
      getRecoveryOwner: () => recoveryOwner,
      getQueueOwnerLiveness: candidate => candidate.processId === deadOwner.processId ? "dead" : "alive",
      isBindingCurrent: binding => store.listWorkspaceBindings().some(candidate =>
        candidate.bindingKey === binding.bindingKey && candidate.updatedAtMs === binding.updatedAtMs),
    });
    assert.deepEqual(getProtection(store.getWorkspaceBinding("/repo/0")!), {
      liveOwner: "clear", acceptedWork: "protected", deliveryAuthority: "clear",
    });
    let deletions = 0;
    let effects = 0;
    const reclamations: unknown[] = [];
    const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => admission });
    const rotation = createTelegramWorkspaceSlotRotation({
      store, getAdmission: () => admission, getLeaderEpoch: () => 1,
      runExclusive: operations.runExclusive,
      getExternalProtection: getProtection, recordEvent() {},
      reclaimDeadOwnerQueuedWork(binding, isCurrent) {
        return operations.run({ operationId: "dead-owner-reclamation-fixture",
          operationKind: "workspace.reclaim-dead-owner-queue",
          scopes: [{ kind: "target", target: binding.target }] }, async () => {
          const result = await reclaim(binding, isCurrent);
          reclamations.push(result);
          return result;
        });
      },
      async deleteThread(authorize) { authorize(); deletions++; },
    });
    const slot = await rotation(async () => {
      const claimed = store.claimWorkspaceIdentity("/fresh", "fresh");
      if (!claimed) throw new TelegramWorkspaceSlotUnavailableError();
      effects++;
      return claimed.slot;
    });
    assert.equal(slot, "A", JSON.stringify(reclamations));
    assert.equal(deletions, 1);
    assert.equal(effects, 1, "The failed allocation must not execute its effect before reclamation");
    assert.deepEqual(reclamations, [{ kind: "recovered", receipts: 1, updateIds: [1] }]);
    assert.deepEqual(follower.journal.read().entries, []);
    assert.equal(store.listWorkspaceBindings().length, 25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Dead-owner reclamation refuses replacement and partial custody, then resumes interrupted exact groups", async (t) => {
  const binding: TelegramWorkspaceThreadBinding = {
    ...createTelegramWorkspaceBindingIdentity("/repo/dead-owner")!,
    target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2,
    journalBindingsComplete: true,
  };
  const owner = { instanceId: "dead", processId: 444, processBirthId: "444:start:dead",
    sessionGeneration: 1, acquisitionId: "acquire-dead", acquiredAtMs: 1 };
  const recoveryOwner = { instanceId: "leader", processId: 555, processBirthId: "555:start:leader",
    sessionGeneration: 2 };
  const entry = (updateId: number, threadId: number, receiptId: string): TelegramUpdateJournalEntry => ({
    updateId, admittedAtMs: 1, state: "queued", queueKind: "prompt", queueReceiptId: receiptId,
    queueOwner: owner, update: { update_id: updateId, message: { message_id: updateId,
      message_thread_id: threadId, chat: { id: 7, type: "private" },
      from: { id: 7, is_bot: false }, text: `update-${updateId}` } },
  });
  const createHarness = (input: {
    initialEntries: TelegramUpdateJournalEntry[];
    getLiveOwner?: (call: number) => "clear" | "protected" | "unknown";
    liveness?: "alive" | "dead" | "unverifiable";
    recover?: (call: number) => "recovered" | "owner-alive" | "owner-unverifiable" | "throw";
  }) => {
    let entries = [...input.initialEntries];
    let protectionCalls = 0;
    let recoveryCalls = 0;
    const source = {
      recoveryKey: "fixture-source",
      readForProtection: () => ({ entries }),
      journal: { recoverDeadQueueOwner(recovery: Parameters<ReturnType<
        typeof createTelegramUpdateJournalStore>["recoverDeadQueueOwner"]>[0]) {
        recoveryCalls++;
        const outcome = input.recover?.(recoveryCalls) ?? "recovered";
        if (outcome === "throw") throw new Error("interrupted publication");
        if (outcome !== "recovered") return { status: outcome, previousOwner: owner,
          recoveredUpdateIds: [] as [], entryCount: entries.length, serializedBytes: 1 };
        entries = entries.filter((candidate) =>
          !recovery.sourceUpdateIds.includes(candidate.updateId));
        return { status: "recovered" as const, previousOwner: owner,
          recoveredUpdateIds: [...recovery.sourceUpdateIds], entryCount: entries.length, serializedBytes: 1 };
      } },
    };
    const getExternalProtection = (): TelegramWorkspaceExternalProtectionEvidence => {
      protectionCalls++;
      const acceptedWork = entries.some((candidate) =>
        (candidate.update as { message?: { message_thread_id?: number } }).message
          ?.message_thread_id === binding.target.threadId)
        ? "protected" as const : "clear" as const;
      return { liveOwner: input.getLiveOwner?.(protectionCalls) ?? "clear",
        acceptedWork, deliveryAuthority: "clear" };
    };
    const reclaim = createTelegramWorkspaceDeadOwnerQueueReclaimer({
      getExternalProtection, getActiveTurnTarget: () => undefined, getQueuedItems: () => [],
      resolveLeaderJournal: () => source, createFollowerJournalResolver: () => () => undefined,
      getRecoveryOwner: () => recoveryOwner,
      getQueueOwnerLiveness: () => input.liveness ?? "dead",
      isBindingCurrent: () => true,
    });
    return { reclaim, get entries() { return entries; }, get recoveryCalls() { return recoveryCalls; } };
  };

  await t.test("replacement owner", async () => {
    const harness = createHarness({ initialEntries: [entry(1, 42, "receipt")],
      getLiveOwner: call => call >= 2 ? "protected" : "clear" });
    assert.deepEqual(await harness.reclaim(binding, () => true),
      { kind: "blocked", reason: "live-owner" });
    assert.equal(harness.recoveryCalls, 0);
    assert.deepEqual(harness.entries.map(candidate => candidate.updateId), [1]);
  });
  await t.test("partial grouped receipt", async () => {
    const harness = createHarness({ initialEntries: [
      entry(1, 42, "shared-receipt"), entry(2, 43, "shared-receipt"),
    ] });
    assert.deepEqual(await harness.reclaim(binding, () => true),
      { kind: "blocked", reason: "unsupported-custody" });
    assert.equal(harness.recoveryCalls, 0);
    assert.deepEqual(harness.entries.map(candidate => candidate.updateId), [1, 2]);
  });
  for (const status of ["owner-alive", "owner-unverifiable"] as const) {
    await t.test(status, async () => {
      const harness = createHarness({ initialEntries: [entry(1, 42, "receipt")],
        liveness: status === "owner-alive" ? "alive" : "unverifiable" });
      assert.deepEqual(await harness.reclaim(binding, () => true),
        { kind: "blocked", reason: status });
      assert.deepEqual(harness.entries.map(candidate => candidate.updateId), [1]);
    });
  }
  await t.test("interrupted mutation and exact retry", async () => {
    const harness = createHarness({ initialEntries: [
      entry(1, 42, "dead-receipt"), entry(2, 43, "unrelated-receipt"),
    ], recover: call => call === 1 ? "throw" : "recovered" });
    assert.deepEqual(await harness.reclaim(binding, () => true),
      { kind: "blocked", reason: "mutation-refused" });
    assert.deepEqual(harness.entries.map(candidate => candidate.updateId), [1, 2]);
    assert.deepEqual(await harness.reclaim(binding, () => true),
      { kind: "recovered", receipts: 1, updateIds: [1] });
    assert.deepEqual(harness.entries.map(candidate => candidate.updateId), [2]);
  });
});

test("Dead-owner pressure reclamation retries an interrupted native journal publication without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-dead-owner-publication-"));
  try {
    const path = join(dir, "inbox.json");
    const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "7:publication" });
    const deadOwner = { instanceId: "dead", processId: 444,
      processBirthId: "444:start:dead", sessionGeneration: 1 };
    const recoveryOwner = { instanceId: "leader", processId: 555,
      processBirthId: "555:start:leader", sessionGeneration: 2 };
    const writer = createTelegramUpdateJournalStore({ path, profileName: "default", botIdentity,
      queueRuntimeIdentity: deadOwner, getQueueProcessLiveness: () => "dead" });
    writer.appendBatch([{ update_id: 1, message: { message_id: 1, message_thread_id: 42,
      chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "once" } }], 1);
    writer.markQueued({ queueKind: "prompt", receiptId: "receipt", sourceUpdateIds: [1], owner: deadOwner });
    let interrupt = true;
    let effects = 0;
    const journal = createTelegramUpdateJournalStore({ path, profileName: "default", botIdentity,
      queueRuntimeIdentity: recoveryOwner, getQueueProcessLiveness: () => "dead",
      onPublicationBoundary(boundary) {
        if (interrupt && boundary === "after-write-before-rename") {
          interrupt = false;
          throw new Error("interrupted publication");
        }
      } });
    const inspect = () => {
      const evidence = inspectTelegramUpdateJournalFamily({ directory: dir, path,
        profile: "default", botIdentity,
        limits: { maxFiles: 128, maxBytes: 1_000_000, maxEntries: 128, maxWork: 10_000 } });
      if (evidence.kind !== "present") throw new Error("fixture journal disappeared");
      return { entries: evidence.file.entries };
    };
    const source = { recoveryKey: path, journal, readForProtection: inspect };
    const binding: TelegramWorkspaceThreadBinding = {
      ...createTelegramWorkspaceBindingIdentity("/repo/publication")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2,
      journalBindingsComplete: true,
    };
    const getExternalProtection = (): TelegramWorkspaceExternalProtectionEvidence => ({
      liveOwner: "clear",
      acceptedWork: inspect().entries.length ? "protected" : "clear",
      deliveryAuthority: "clear",
    });
    const reclaim = createTelegramWorkspaceDeadOwnerQueueReclaimer({
      getExternalProtection, getActiveTurnTarget: () => undefined, getQueuedItems: () => [],
      resolveLeaderJournal: () => source, createFollowerJournalResolver: () => () => undefined,
      getRecoveryOwner: () => recoveryOwner, getQueueOwnerLiveness: () => "dead",
      isBindingCurrent: () => true,
    });
    const invoke = async () => {
      const result = await reclaim(binding, () => true);
      if (result.kind === "recovered") effects += result.updateIds.length;
      return result;
    };
    assert.deepEqual(await invoke(), { kind: "blocked", reason: "mutation-refused" });
    assert.deepEqual(inspect().entries.map(entry => entry.updateId), [1]);
    assert.deepEqual(await invoke(), { kind: "recovered", receipts: 1, updateIds: [1] });
    assert.equal(effects, 1);
    assert.deepEqual(inspect().entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Slot rotation cancels proven Telegram rejection but retains ambiguous deletion without replay", async (t) => {
  for (const outcome of ["rejected", "malformed", "forged", "server", "network", "false"] as const) {
    await t.test(outcome, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-telegram-rotation-rejection-"));
      const attempts: string[] = [];
      t.mock.method(Date, "now", () => 1000);
      let requests = 0;
      let success = false;
      const fetch = async () => {
        requests++;
        if (success) return new Response(JSON.stringify({ ok: true, result: true }));
        if (outcome === "network") throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        if (outcome === "forged") throw Object.assign(new Error("Too Many Requests"), { status: 429 });
        if (outcome === "false") return new Response(JSON.stringify({ ok: true, result: false }));
        const status = outcome === "server" ? 500 : 429;
        return new Response(outcome === "malformed" ? "invalid JSON" : JSON.stringify({
          ok: false, error_code: status, description: "fixture rejection",
        }), { status });
      };
      t.mock.method(globalThis, "fetch", fetch);
      const restoreFetch = setTelegramApiHttpsFetchForTesting(fetch);
      try {
        const admission = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"),
          profileKey: "default", owner: { processId: process.pid, processBirthId: `${process.pid}:rejection` },
          getNowMs: () => 1000, getProcessLiveness: () => "alive" });
        const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 1000,
          getExternalReservedSlots: admission.listReservedSlots });
        for (let index = 0; index < 26; index++) addBinding(store, index, index + 1);
        await store.persist();
        const api = createDefaultTelegramBridgeApiRuntime({
          getBotToken: () => "123:fixture", recordRuntimeEvent() {}, workspaceAdmission: admission,
        });
        const rotation = createTelegramWorkspaceSlotRotation({
          store, getAdmission: () => admission, getLeaderEpoch: () => 1,
          runExclusive: createTelegramWorkspaceOperationGate().runExclusive,
          getExternalProtection: clearExternalProtection, recordEvent() {},
          deleteThread(authorize) {
            attempts.push(admission.read().fence!.operationId);
            return api.deleteWorkspaceThread(authorize);
          },
        });
        await assert.rejects(rotation(async () => { throw new TelegramWorkspaceSlotUnavailableError(); }),
          outcome === "rejected" ? /delete-rejected/ : /delete-unconfirmed/);
        assert.equal(requests, 1);
        assert.equal(store.listWorkspaceBindings().length, 26);
        if (outcome === "rejected") {
          assert.equal(admission.read().fence, undefined);
          assert.deepEqual(store.listWorkspaceRetirementIntents(), []);
          const lease = admission.acquireAdmission({ operationId: "after-rejection",
            operationKind: "workspace.register-follower", scope: { kind: "profile" } });
          assert.equal(lease.kind, "acquired");
          if (lease.kind === "acquired") admission.releaseAdmission(lease.lease);
          assert.equal(await rotation(async () => "existing binding"), "existing binding");
          assert.equal(requests, 1);
          success = true;
          assert.equal(await rotation(async () => {
            const claim = store.claimWorkspaceIdentity("/fresh", "fresh");
            if (!claim) throw new TelegramWorkspaceSlotUnavailableError();
            return claim.slot;
          }), "A");
          assert.equal(requests, 2);
          assert.equal(new Set(attempts).size, 2, "Fresh attempts need distinct authority even with the same clock tick");
        } else {
          assert.equal(admission.read().fence?.phase, "deletion-issued");
          await assert.rejects(rotation(async () => "existing binding"), /delete-unconfirmed/);
          assert.equal(requests, 1);
        }
      } finally {
        restoreFetch();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("Rejected rotation recovery finishes each durable cancellation prefix without another delete", async (t) => {
  for (const fault of ["rejection", "withdrawal", "withdrawal-same-store", "withdrawal-ack", "authority", "release", "release-ack"] as const) {
    await t.test(fault, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-telegram-rejection-recovery-"));
      const path = join(dir, "state.json");
      const admissionPath = join(dir, "admission.json");
      let requests = 0;
      let fail = true;
      let epoch = 1;
      const fetch = async () => {
        requests++;
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests" }), { status: 429 });
      };
      t.mock.method(globalThis, "fetch", fetch);
      const restoreFetch = setTelegramApiHttpsFetchForTesting(fetch);
      try {
        const ledger = createRetirementAdmission(admissionPath);
        const admission = { ...ledger,
          confirmRetirementRejection(expected: Parameters<typeof ledger.confirmRetirementRejection>[0]) {
            const result = ledger.confirmRetirementRejection(expected);
            if (fail && fault === "rejection") throw new Error("interrupted rejection ACK");
            return result;
          },
          completeRejectedRetirementFence(expected: Parameters<typeof ledger.completeRejectedRetirementFence>[0]) {
            if (fail && fault === "release") throw new Error("interrupted release");
            const result = ledger.completeRejectedRetirementFence(expected);
            if (fail && fault === "release-ack") throw new Error("interrupted release ACK");
            return result;
          },
        };
        const backing = createTelegramTopicTargetStore({ path, getExternalReservedSlots: ledger.listReservedSlots });
        const store = { ...backing, async persist() {
          const cancelling = ledger.read().fence?.phase === "deletion-rejected";
          if (fail && cancelling && (fault === "withdrawal" || fault === "withdrawal-same-store")) {
            throw new Error("interrupted withdrawal");
          }
          await backing.persist();
          if (fail && cancelling && fault === "withdrawal-ack") throw new Error("interrupted withdrawal ACK");
          if (fail && cancelling && fault === "authority") epoch = 2;
        } };
        for (let index = 0; index < 26; index++) addBinding(store, index, index + 1);
        await store.persist();
        const bindings = store.listWorkspaceBindings();
        const api = createDefaultTelegramBridgeApiRuntime({
          getBotToken: () => "123:fixture", recordRuntimeEvent() {}, workspaceAdmission: admission,
        });
        const rotation = createTelegramWorkspaceSlotRotation({
          store, getAdmission: () => admission, getLeaderEpoch: () => epoch,
          runExclusive: createTelegramWorkspaceOperationGate().runExclusive,
          getExternalProtection: clearExternalProtection, recordEvent() {}, deleteThread: api.deleteWorkspaceThread,
        });
        await assert.rejects(rotation(async () => { throw new TelegramWorkspaceSlotUnavailableError(); }),
          /interrupted|fence-release-unconfirmed|delete-rejected|authority-changed/);
        assert.equal(requests, 1);
        assert.equal(ledger.read().fence?.phase, fault === "release-ack" ? undefined : "deletion-rejected");
        fail = false;
        const successorAdmission = createRetirementAdmission(admissionPath, "successor");
        const successorStore = fault === "withdrawal-same-store" ? store : createTelegramTopicTargetStore({ path,
          getExternalReservedSlots: successorAdmission.listReservedSlots });
        const successor = createTelegramWorkspaceSlotRotation({
          store: successorStore, getAdmission: () => successorAdmission, getLeaderEpoch: () => 2,
          runExclusive: createTelegramWorkspaceOperationGate().runExclusive,
          getExternalProtection() { throw new Error("Cancellation must not require deletion eligibility"); },
          recordEvent() {}, async deleteThread() { throw new Error("Deletion must not replay during cancellation"); },
        });
        assert.equal(await successor(async () => "restored binding"), "restored binding");
        assert.equal(successorAdmission.read().fence, undefined);
        const restored = createTelegramTopicTargetStore({ path });
        await restored.load();
        assert.deepEqual(restored.listWorkspaceRetirementIntents(), []);
        assert.deepEqual(restored.listWorkspaceBindings(), bindings);
        assert.equal(requests, 1);
      } finally {
        restoreFetch();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("Slot rotation recovers a committed binding removal before fence completion without deleting again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-rotation-commit-ready-"));
  try {
    const path = join(dir, "state.json");
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => admission });
    const store = createTelegramTopicTargetStore({ path, getExternalReservedSlots: admission.listReservedSlots });
    for (let index = 0; index < 26; index++) addBinding(store, index, index + 1);
    await store.persist();
    let deletions = 0;
    const rotation = createTelegramWorkspaceSlotRotation({
      store, getAdmission: () => ({ ...admission, completeRetirementFence() { throw new Error("interrupted completion"); } }),
      runExclusive: operations.runExclusive, getLeaderEpoch: () => 1,
      getExternalProtection: clearExternalProtection, recordEvent() {},
      async deleteThread(authorize) { authorize(); deletions++; },
    });
    await assert.rejects(rotation(async () => { throw new TelegramWorkspaceSlotUnavailableError(); }), /fence-release-unconfirmed/);
    assert.equal(deletions, 1);
    assert.equal(store.listWorkspaceBindings().length, 25);
    assert.deepEqual(store.listWorkspaceRetirementIntents(), []);
    assert.equal(admission.read().fence?.phase, "commit-ready");
    const reopened = createTelegramTopicTargetStore({ path, getExternalReservedSlots: admission.listReservedSlots });
    const successor = createTelegramWorkspaceSlotRotation({
      store: reopened, getAdmission: () => admission, runExclusive: operations.runExclusive,
      getLeaderEpoch: () => 2, getExternalProtection: clearExternalProtection, recordEvent() {},
      async deleteThread() { throw new Error("must not delete twice"); },
    });
    const restoredSlot = await successor(async () => reopened.claimWorkspaceIdentity("/fresh", "new")?.slot);
    assert.equal(restoredSlot, "A");
    assert.equal(admission.read().fence, undefined);
    assert.equal(deletions, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Slot rotation validates leader authority again at deletion issuance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-rotation-epoch-"));
  try {
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    for (let index = 0; index < 26; index++) addBinding(store, index, index + 1);
    await store.persist();
    let epoch = 1;
    let issued = 0;
    const rotate = createTelegramWorkspaceSlotRotation({
      store, getAdmission: () => admission, runExclusive: createTelegramWorkspaceOperationGate().runExclusive,
      getLeaderEpoch: () => epoch, getExternalProtection: clearExternalProtection, recordEvent() {},
      async deleteThread(authorize) { epoch = 2; authorize(); issued++; },
    });
    await assert.rejects(rotate(async () => { throw new Error("unrelated failure"); }), /unrelated failure/);
    assert.equal(admission.read().fence, undefined);
    await assert.rejects(rotate(async () => { throw new TelegramWorkspaceSlotUnavailableError(); }), /delete-unconfirmed/);
    assert.equal(issued, 0);
    assert.equal(store.listWorkspaceBindings().length, 26);
    assert.equal(admission.read().fence?.phase, "deletion-issued");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Retirement waits for active admission and releases an unissued fence on late protection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-fence-race-"));
  try {
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:race", reason: "pressure" as const,
      profileKey: "default", binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    const leaseResult = admission.acquireAdmission({
      operationId: "active-journal",
      operationKind: "journal.append",
      scope: { kind: "target", target: binding.target },
    });
    assert.equal(leaseResult.kind, "acquired");
    let deletions = 0;
    const execute = (
      getExternalProtection: () => TelegramWorkspaceExternalProtectionEvidence =
        clearExternalProtection,
    ) =>
      executeTelegramWorkspaceRetirement({
        store, intent, admission, getExternalProtection,
        getLeaderEpoch: () => 1, getProfileKey: () => "default",
        runExclusive: async <T>(operation: () => Promise<T>) => operation(),
        async deleteForumTopic() { deletions++; },
      });
    assert.deepEqual(await execute(), { kind: "retained", reason: "admission-active" });
    assert.equal(deletions, 0);
    assert.equal(admission.read().fence, undefined);
    if (leaseResult.kind === "acquired") {
      assert.equal(admission.releaseAdmission(leaseResult.lease), true);
    }
    let protectionReads = 0;
    assert.deepEqual(await execute(() => {
      protectionReads++;
      return protectionReads === 1
        ? clearExternalProtection()
        : { ...clearExternalProtection(), liveOwner: "protected" as const };
    }), { kind: "retained", reason: "protection-changed" });
    assert.equal(protectionReads, 2);
    assert.equal(deletions, 0);
    assert.equal(admission.read().fence, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Retirement execution retains unknown deletion without issuing a second request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-retained-"));
  try {
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:a", reason: "pressure" as const, profileKey: "default",
      binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    const base = {
      store, intent, admission, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
    };
    let deletionCalls = 0;
    assert.deepEqual(await executeTelegramWorkspaceRetirement({ ...base,
      async deleteForumTopic(permit) {
        deletionCalls++;
        assert.equal(permit.retirementIntentId, intent.id);
        assert.equal(admission.read().fence?.phase, "deletion-issued");
        assert.deepEqual(admission.acquireAdmission({
          operationId: "late-api",
          operationKind: "api.sendMessage",
          scope: { kind: "target", target: binding.target },
        }), { kind: "blocked", reason: "retirement-fenced" });
        throw new Error("ACK unknown");
      },
    }), { kind: "retained", reason: "delete-unconfirmed" });
    assert.equal(deletionCalls, 1);
    assert.equal(admission.read().fence?.phase, "deletion-issued");
    assert.equal(store.getWorkspaceBinding("/repo")?.slot, "A");
    assert.deepEqual(store.listWorkspaceRetirementIntents(), [intent]);
    assert.deepEqual(await executeTelegramWorkspaceRetirement({ ...base,
      async deleteForumTopic() { throw new Error("must not issue twice"); },
      confirmTargetAbsent: async () => "unknown",
    }), { kind: "retained", reason: "delete-unconfirmed" });
    assert.equal(deletionCalls, 1);
    assert.equal(store.claimWorkspaceIdentity("/fresh", "fresh")?.slot, "B");
    store.releaseWorkspaceClaim("fresh");
    assert.deepEqual(await executeTelegramWorkspaceRetirement({ ...base,
      async deleteForumTopic() { throw new Error("must not issue twice"); },
      async confirmTargetAbsent() {
        assert.equal(store.claimWorkspaceIdentity("/repo", "racer"), undefined);
        return "absent";
      },
    }), { kind: "retired", bindingKey: binding.bindingKey, slot: "A" });
    assert.equal(deletionCalls, 1);
    assert.equal(store.getWorkspaceBinding("/repo"), undefined);
    assert.deepEqual(store.listWorkspaceRetirementIntents(), []);
    assert.equal(admission.read().fence, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Closed-but-existing topic evidence retains an issued retirement fence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-closed-"));
  try {
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:closed", reason: "pressure" as const,
      profileKey: "default", binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    assert.deepEqual(await executeTelegramWorkspaceRetirement({
      store, intent, admission, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
      async deleteForumTopic() {
        throw new TelegramApiStaleTargetError("forum topic closed",
          { chatId: 7, threadId: 42 });
      },
    }), { kind: "retained", reason: "delete-unconfirmed" });
    assert.equal(admission.read().fence?.phase, "deletion-issued");
    assert.equal(store.getWorkspaceBinding("/repo")?.slot, "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Killed executor leaves durable intent for successor already-absence recovery", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-kill-"));
  const path = join(dir, "state.json");
  const admissionPath = join(dir, "admission.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:a", reason: "pressure" as const, profileKey: "default",
      binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    await store.persist();
    const script = `
      import { createTelegramTopicTargetStore } from './lib/threads.ts';
      import { executeTelegramWorkspaceRetirement } from './lib/workspace-retirement.ts';
      import { createTelegramWorkspaceAdmissionLedger } from './lib/workspace-admission.ts';
      const store = createTelegramTopicTargetStore({ path: process.argv[1] });
      const admission = createTelegramWorkspaceAdmissionLedger({
        path: process.argv[2], profileKey: 'default',
        owner: { processId: process.pid, processBirthId: process.pid + ':retirement-child' },
        getProcessLiveness: () => 'alive',
      });
      await store.load();
      const intent = store.listWorkspaceRetirementIntents()[0];
      await executeTelegramWorkspaceRetirement({
        store, intent, admission,
        getExternalProtection: () => ({ liveOwner: 'clear', acceptedWork: 'clear', deliveryAuthority: 'clear' }),
        getLeaderEpoch: () => 1, getProfileKey: () => 'default',
        runExclusive: async (operation) => operation(),
        deleteForumTopic: async () => {
          console.log('remote-deleted');
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        },
      });
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module",
      "--eval", script, path, admissionPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("remote-deleted")) resolve();
      });
      child.once("exit", (code) => reject(new Error(
        `retirement fixture exited before deletion marker (${code}): ${stderr}`,
      )));
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const restored = createTelegramTopicTargetStore({ path });
    const successorAdmission = createRetirementAdmission(admissionPath, "successor");
    await restored.load();
    assert.equal(restored.getWorkspaceBinding("/repo")?.slot, "A");
    assert.deepEqual(restored.listWorkspaceRetirementIntents(), [intent]);
    const runExclusive = async <T>(operation: () => Promise<T>) => operation();
    const adoption = await adoptTelegramWorkspaceRetirementIntent({
      store: restored, intent, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 2, getProfileKey: () => "default", runExclusive,
    });
    assert.equal(adoption.kind, "adopted");
    if (adoption.kind !== "adopted") return;
    assert.deepEqual(await executeTelegramWorkspaceRetirement({
      store: restored, intent: adoption.intent, admission: successorAdmission,
      getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 2, getProfileKey: () => "default", runExclusive,
      async deleteForumTopic() { throw new Error("must not issue after successor adoption"); },
      confirmTargetAbsent: async () => "absent",
    }), { kind: "retired", bindingKey: binding.bindingKey, slot: "A" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Policy disable after deletion retains intent for successor adoption and already-absence retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-leadership-"));
  try {
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
    const admission = createRetirementAdmission(join(dir, "admission.json"));
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:a", reason: "pressure" as const, profileKey: "default",
      binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    let epoch = 1;
    let cleanupEnabled = true;
    const runExclusive = async <T>(operation: () => Promise<T>) => operation();
    assert.deepEqual(await executeTelegramWorkspaceRetirement({
      store, intent, admission, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => epoch, getProfileKey: () => "default",
      isCurrent: () => cleanupEnabled, runExclusive,
      async deleteForumTopic() { cleanupEnabled = false; },
    }), { kind: "retained", reason: "authority-changed" });
    assert.equal(store.getWorkspaceBinding("/repo")?.slot, "A");
    assert.deepEqual(store.listWorkspaceRetirementIntents(), [intent]);
    cleanupEnabled = true;
    epoch = 2;
    const adoption = await adoptTelegramWorkspaceRetirementIntent({
      store, intent, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => epoch, getProfileKey: () => "default", runExclusive,
    });
    assert.equal(adoption.kind, "adopted");
    if (adoption.kind !== "adopted") return;
    assert.deepEqual(await executeTelegramWorkspaceRetirement({
      store, intent: adoption.intent, admission, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => epoch, getProfileKey: () => "default", runExclusive,
      async deleteForumTopic() { throw new Error("must not reissue committed deletion"); },
    }), { kind: "retired", bindingKey: binding.bindingKey, slot: "A" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Ambiguous persistence after durable rename reloads committed retirement without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-ambiguous-"));
  const path = join(dir, "state.json");
  const admission = createRetirementAdmission(join(dir, "admission.json"));
  let ambiguous = false;
  try {
    const store = createTelegramTopicTargetStore({ path, commitPersist(commit) {
      commit();
      if (ambiguous) throw new Error("publication acknowledgement lost");
      return true;
    } });
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:a", reason: "pressure" as const, profileKey: "default",
      binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    await store.persist();
    ambiguous = true;
    let calls = 0;
    assert.deepEqual(await executeTelegramWorkspaceRetirement({
      store, intent, admission, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
      async deleteForumTopic() { calls++; },
    }), { kind: "retired", bindingKey: binding.bindingKey, slot: "A" });
    assert.equal(calls, 1);
    assert.equal(store.getWorkspaceBinding("/repo"), undefined);
    assert.deepEqual(store.listWorkspaceRetirementIntents(), []);
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.equal(restored.getWorkspaceBinding("/repo"), undefined);
    assert.deepEqual(restored.listWorkspaceRetirementIntents(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Confirmed deletion releases a slot only after durable exact retirement and retries failed persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-commit-"));
  const path = join(dir, "state.json");
  const admission = createRetirementAdmission(join(dir, "admission.json"));
  let canCommit = true;
  try {
    const store = createTelegramTopicTargetStore({ path, commitPersist(commit) {
      if (!canCommit) return false;
      commit();
      return true;
    } });
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", inactiveSinceMs: 1, updatedAtMs: 2 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:a", reason: "pressure" as const, profileKey: "default",
      binding, leaderEpoch: 1, requestedAtMs: 3 };
    store.upsertWorkspaceRetirementIntent(intent);
    await store.persist();
    canCommit = false;
    let calls = 0;
    const execute = () => executeTelegramWorkspaceRetirement({
      store, intent, admission, getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 1, getProfileKey: () => "default",
      runExclusive: async <T>(operation: () => Promise<T>) => operation(),
      async deleteForumTopic() {
        calls++;
        if (calls > 1) throw new Error("must not issue deletion twice");
      },
    });
    await assert.rejects(execute(), /lost exact transport ownership/);
    assert.equal(store.getWorkspaceBinding("/repo")?.slot, "A");
    assert.deepEqual(store.listWorkspaceRetirementIntents(), [intent]);
    assert.equal(store.claimWorkspaceIdentity("/fresh", "fresh")?.slot, "B");
    store.releaseWorkspaceClaim("fresh");
    canCommit = true;
    assert.deepEqual(await execute(), { kind: "retired",
      bindingKey: binding.bindingKey, slot: "A" });
    assert.equal(store.getWorkspaceBinding("/repo"), undefined);
    assert.deepEqual(store.listWorkspaceRetirementIntents(), []);
    assert.equal(store.claimWorkspaceIdentity("/fresh", "fresh")?.slot, "A");
    assert.equal(calls, 1);
    assert.equal(admission.read().fence, undefined);
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.equal(restored.getWorkspaceBinding("/repo"), undefined);
    assert.deepEqual(restored.listWorkspaceRetirementIntents(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pressure preparation persists the oldest eligible exact intent and resumes it idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-pressure-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    for (let index = 0; index < 26; index++) {
      addBinding(store, index, index === 5 ? 10 : 20 + index,
        index === 5 ? "session-a" : undefined);
    }
    await store.persist();
    const deps = {
      store,
      getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => "leader:1",
      getProfileKey: () => "default",
      getNowMs: () => 1000,
    };
    const prepared = await prepareTelegramWorkspaceRetirement(deps);
    assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") return;
    assert.equal(prepared.intent.binding.cwd, "/repo/5");
    assert.equal(prepared.intent.binding.slot, "F");
    assert.equal(prepared.intent.binding.inactiveSinceMs, 10);
    assert.equal(prepared.intent.binding.sessionId, "session-a");
    assert.equal(prepared.intent.profileKey, "default");
    assert.equal(prepared.intent.leaderEpoch, "leader:1");
    assert.deepEqual(await prepareTelegramWorkspaceRetirement(deps), prepared);
    assert.equal(store.listWorkspaceRetirementIntents().length, 1);
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.deepEqual(restored.listWorkspaceRetirementIntents(), [prepared.intent]);
    assert.equal(restored.getWorkspaceBinding("/repo/5"), undefined);
    assert.equal(restored.getWorkspaceBinding(
      "/repo/5", "a", "session-a")?.slot, "F");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pressure preparation counts standalone reservations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-pressure-reservation-"));
  try {
    const capacity = createTelegramTopicTargetStore({ path: join(dir, "capacity.json"), getNowMs: () => 1000 });
    for (let index = 0; index < 25; index++) addBinding(capacity, index, index + 1);
    capacity.reserveThread({ target: { chatId: 7, threadId: 99 }, slot: "Z",
      reason: "leader-reload", createdAtMs: 1, updatedAtMs: 1 });
    const pressure = await prepareTelegramWorkspaceRetirement({
      store: capacity,
      getExternalProtection: clearExternalProtection,
      getLeaderEpoch: () => 1,
      getProfileKey: () => "default",
      getNowMs: () => 1000,
    });
    assert.equal(pressure.kind, "ready");
    if (pressure.kind === "ready") assert.equal(pressure.intent.binding.slot, "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Preparation removes an unpersisted intent when protection or leader authority changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retirement-fence-"));
  try {
    const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 1000 });
    for (let index = 0; index < 26; index++) addBinding(store, index, index + 1);
    let epoch = 1;
    let observations = 0;
    await assert.rejects(prepareTelegramWorkspaceRetirement({
      store,
      getExternalProtection() {
        observations++;
        if (observations === 27) epoch = 2;
        return clearExternalProtection();
      },
      getLeaderEpoch: () => epoch,
      getProfileKey: () => "default",
      getNowMs: () => 1000,
    }), /lost leader authority/);
    assert.equal(store.listWorkspaceRetirementIntents().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
