/**
 * Inactive Telegram Thread cleanup admission regressions
 * Zones: telegram threads, workspace lifecycle
 */

import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import nodeTest from "node:test";

import { captureTelegramInactiveThreadCleanupEvidence,
  cleanReviewedInactiveThreads, commitTelegramInactiveThreadCleanup,
  createTelegramInactiveThreadCleanupReviewRuntime,
  createTelegramInactiveThreadCleanupSettingsPort,
  createTelegramThreadCleanupPermitRuntime,
  createTelegramThreadCleanupWorkStore, executeTelegramInactiveThreadCleanup,
  planTelegramInactiveThreadCleanup } from "../lib/thread-cleanup-manager.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";

const binding = {
  cwd: "/repo/a", workspaceKey: "workspace:a", instanceSlot: "a", slot: "A", bindingKey: "binding:a",
  target: { chatId: -1001, threadId: 7 }, inactiveSinceMs: 10, updatedAtMs: 20,
};
const execFileAsync = promisify(execFile);
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
const cleanupOwner = { processId: 1, processBirthId: "1:test" };
const clear = {
  bindingKey: "binding:a", target: { chatId: -1001, threadId: 7 },
  liveOwner: "clear" as const, acceptedWork: "clear" as const,
  deliveryAuthority: "clear" as const,
};

test("Cleanup planner admits only exact fully-clear inactive bindings", () => {
  assert.deepEqual(planTelegramInactiveThreadCleanup({
    profileName: "work", bindings: [binding], protection: [clear],
  }), [{ profileName: "work", bindingKey: "binding:a", cwd: "/repo/a",
    workspaceKey: "workspace:a", instanceSlot: "a", slot: "A", target: { chatId: -1001, threadId: 7 },
    inactiveSinceMs: 10, bindingUpdatedAtMs: 20 }]);
  assert.deepEqual(planTelegramInactiveThreadCleanup({
    profileName: "work", bindings: [{ ...binding, inactiveSinceMs: undefined }], protection: [clear],
  }), []);
  assert.deepEqual(planTelegramInactiveThreadCleanup({
    profileName: "work", bindings: [{ ...binding, slot: undefined }], protection: [clear],
  }), []);
  assert.deepEqual(planTelegramInactiveThreadCleanup({
    profileName: "work", bindings: [binding],
    protection: [{ ...clear, liveOwner: "unknown" }],
  }), []);
});

test("Cleanup evidence adapter preserves full records for protection and carries competing work", () => {
  let observedJournalKeys: readonly string[] | undefined;
  const evidence = captureTelegramInactiveThreadCleanupEvidence({
    profileName: "work",
    listBindings: () => [{ ...binding, journalBindingKeys: ["journal:a"] }],
    getProtection: (source) => {
      observedJournalKeys = source.journalBindingKeys;
      throw new Error("registry unavailable");
    },
    listReservations: () => [{ target: { chatId: -1001, threadId: 8 } }],
    listPendingProvisions: () => [{}, { target: { chatId: -1001, threadId: 9 } }],
    listPendingCleanups: () => [{ target: { chatId: -1001, threadId: 10 } }],
  });
  assert.deepEqual(observedJournalKeys, ["journal:a"]);
  assert.deepEqual(evidence.protection, [{ bindingKey: "binding:a", target: binding.target,
    liveOwner: "unknown", acceptedWork: "unknown", deliveryAuthority: "unknown" }]);
  assert.deepEqual(evidence.reservedTargets, [{ chatId: -1001, threadId: 8 }]);
  assert.deepEqual(evidence.provisioningTargets, [{ chatId: -1001, threadId: 9 }]);
  assert.deepEqual(evidence.cleanupTargets, [{ chatId: -1001, threadId: 10 }]);
  assert.deepEqual(planTelegramInactiveThreadCleanup(evidence), []);
});

test("Cleanup review durably prepares one canonical work-set under admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-review-"));
  try {
    const store = createTelegramThreadCleanupWorkStore({ path: join(dir, "cleanup.json"),
      profileName: "work", tokenSha256: "a".repeat(64) });
    let admissions = 0;
    const runtime = createTelegramInactiveThreadCleanupReviewRuntime({
      getProfileName: () => "work", listBindings: () => [binding], getProtection: () => clear,
      listReservations: () => [], listPendingProvisions: () => [], listPendingCleanups: () => [],
      getWorkStore: () => store,
      async runWorkspaceOperation(_input, operation) { admissions += 1; return operation(); },
    });
    const first = await runtime.review();
    const second = await runtime.review();
    assert.deepEqual(second, first);
    assert.equal(first.count, 1);
    assert.equal(admissions, 2);
    assert.equal(store.list().length, 1);
    assert.match(first.operationId!, /^thread-cleanup:[a-f0-9]{32}$/u);
    assert.equal(store.list()[0]!.operationId, first.operationId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup permit runtime revalidates after fence and retains commit-ready state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-permit-"));
  try {
    let now = 100;
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"),
      profileKey: "work", owner: { processId: 1, processBirthId: "1:test" }, getNowMs: () => now });
    const candidate = planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    let revalidations = 0;
    const runtime = createTelegramThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 3, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => now,
      async revalidateUnderFence() { revalidations += 1; return true; } });
    const workStore = createTelegramThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => now });
    workStore.prepare("thread-cleanup:test", [candidate]);
    const acquired = await runtime.acquire(candidate, "thread-cleanup:test");
    assert.equal(acquired.kind, "issued");
    if (acquired.kind !== "issued") throw new Error("Expected cleanup permit");
    assert.equal(acquired.permit.destructiveKind, "manual-thread-cleanup");
    workStore.recordDeletionIssued({ operationId: "thread-cleanup:test",
      bindingKey: candidate.bindingKey, bindingUpdatedAtMs: candidate.bindingUpdatedAtMs,
      permit: acquired.permit });
    assert.equal((await runtime.acquire(candidate, "thread-cleanup:test")).kind, "already-issued");
    assert.equal(revalidations, 1);
    now = 110;
    assert.equal(await runtime.settleDeleted(acquired.fence, async () => false), "commit-pending");
    const ready = ledger.read().fence!;
    assert.equal(ready.phase, "commit-ready");
    let bindingCommits = 0;
    assert.equal(await runtime.settleDeleted(ready, () => commitTelegramInactiveThreadCleanup({
      store: workStore, operationId: "thread-cleanup:test", bindingKey: candidate.bindingKey,
      async commitBinding() { bindingCommits += 1; return true; },
    })), "completed");
    assert.equal(bindingCommits, 1);
    assert.equal(workStore.list()[0]?.entries[0]?.state, "deleted");
    assert.equal(ledger.read().fence, undefined);
    const drifted = createTelegramThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 3, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => now,
      async revalidateUnderFence() { return false; } });
    assert.equal((await drifted.acquire(candidate, "thread-cleanup:drift")).kind, "blocked");
    assert.equal(ledger.read().fence, undefined);
    const wrongProfile = createTelegramThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 3, getProfileName: () => "other", getOwner: () => cleanupOwner,
      canAdoptFence: () => false, getNowMs: () => now,
      async revalidateUnderFence() { throw new Error("must not revalidate cross-profile work"); } });
    assert.equal((await wrongProfile.acquire(candidate, "thread-cleanup:profile")).kind, "blocked");
    assert.equal(ledger.read().fence, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Hidden cleanup coordinator calls fake deletion once and never replays ambiguity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-hidden-"));
  try {
    const operationId = `thread-cleanup:${"b".repeat(32)}`;
    const store = createTelegramThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 100 });
    const candidate = planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    store.prepare(operationId, [candidate]);
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: { processId: 1, processBirthId: "1:test" }, getNowMs: () => 100 });
    const permitRuntime = createTelegramThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 4, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => 100,
      async revalidateUnderFence() { return true; } });
    let deletes = 0;
    const run = () => cleanReviewedInactiveThreads({ store, operationId, permitRuntime,
      async resolveFullBinding() { return binding; },
      async deleteWithPermit() { deletes += 1; throw new Error("lost delete ack"); },
      async commitBinding() { throw new Error("must not commit ambiguous deletion"); },
    });
    assert.deepEqual(await run(), { deleted: 0, outcomeUnknown: 1, blocked: 0,
      recovery: "deletion-outcome-unknown" });
    assert.deepEqual(await run(), { deleted: 0, outcomeUnknown: 1, blocked: 0,
      recovery: "deletion-outcome-unknown" });
    assert.equal(deletes, 1);
    assert.equal(store.list()[0]?.entries[0]?.state, "outcome-unknown");
    assert.equal(ledger.read().fence?.phase, "deletion-issued");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Hidden cleanup coordinator completes fake deletion, binding commit, and work-set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-complete-"));
  try {
    const operationId = `thread-cleanup:${"c".repeat(32)}`;
    let failWorkSetPublish = false;
    let cleanupPublicationCount = 0;
    const store = createTelegramThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 100,
      onPublicationBoundary(boundary) {
        if (failWorkSetPublish && boundary === "after-write-before-rename" &&
            ++cleanupPublicationCount === 2) {
          failWorkSetPublish = false;
          throw new Error("simulated work-set publication crash");
        }
      } });
    const candidate = planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    store.prepare(operationId, [candidate]);
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: { processId: 1, processBirthId: "1:test" }, getNowMs: () => 100 });
    const permitRuntime = createTelegramThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 5, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => 100,
      async revalidateUnderFence() { return true; } });
    let deletes = 0;
    let commits = 0;
    const cleanInactiveThreads = createTelegramInactiveThreadCleanupSettingsPort({
      store, permitRuntime, async resolveFullBinding() { return binding; },
      async deleteWithPermit() { deletes += 1; },
      async commitBinding() { commits += 1; return true; },
    });
    failWorkSetPublish = true;
    assert.deepEqual(await cleanInactiveThreads(operationId),
      { deleted: 0, outcomeUnknown: 1, blocked: 0, recovery: "commit-ready" });
    assert.equal(ledger.read().fence?.phase, "commit-ready");
    const liveSuccessorOwner = { processId: 2, processBirthId: "2:live" };
    const liveSuccessorLedger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: liveSuccessorOwner, getNowMs: () => 105,
      getProcessLiveness: () => "alive" });
    const liveSuccessorRuntime = createTelegramThreadCleanupPermitRuntime({ ledger: liveSuccessorLedger,
      getLeaderEpoch: () => 6, getProfileName: () => "work", getOwner: () => liveSuccessorOwner, canAdoptFence: () => false, getNowMs: () => 105,
      async revalidateUnderFence() { return true; } });
    const liveBlockedPort = createTelegramInactiveThreadCleanupSettingsPort({
      store, permitRuntime: liveSuccessorRuntime, async resolveFullBinding() { return binding; },
      async deleteWithPermit() { deletes += 1; }, async commitBinding() { commits += 1; return true; },
    });
    assert.deepEqual(await liveBlockedPort(operationId),
      { deleted: 0, outcomeUnknown: 1, blocked: 0, recovery: "authority-blocked" });
    assert.equal(commits, 1);
    const successorOwner = { processId: 2, processBirthId: "2:test" };
    const successorLedger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: successorOwner, getNowMs: () => 110,
      getProcessLiveness: owner => owner.processId === 1 ? "dead" : "alive" });
    const successorRuntime = createTelegramThreadCleanupPermitRuntime({ ledger: successorLedger,
      getLeaderEpoch: () => 6, getProfileName: () => "work", getOwner: () => successorOwner, canAdoptFence: () => true, getNowMs: () => 110,
      async revalidateUnderFence() { return true; } });
    const successorPort = createTelegramInactiveThreadCleanupSettingsPort({
      store, permitRuntime: successorRuntime,
      async resolveFullBinding() { throw new Error("binding is already absent"); },
      async deleteWithPermit() { deletes += 1; },
      async commitBinding() { commits += 1; return true; },
    });
    assert.deepEqual(await successorPort(operationId),
      { deleted: 1, outcomeUnknown: 0, blocked: 0 });
    assert.equal(deletes, 1);
    assert.equal(commits, 2);
    assert.equal(store.list()[0]?.entries[0]?.state, "deleted");
    assert.equal(ledger.read().fence, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Lost work-set commit acknowledgement completes retained fence without re-delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-lost-commit-"));
  try {
    const operationId = `thread-cleanup:${"e".repeat(32)}`;
    let failAfterRename = false;
    let cleanupPublicationCount = 0;
    const store = createTelegramThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 100,
      onPublicationBoundary(boundary) {
        if (failAfterRename && boundary === "after-rename" &&
            ++cleanupPublicationCount === 2) {
          failAfterRename = false;
          throw new Error("lost work-set commit acknowledgement");
        }
      } });
    const candidate = planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    store.prepare(operationId, [candidate]);
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: cleanupOwner, getNowMs: () => 100 });
    const permitRuntime = createTelegramThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 7, getProfileName: () => "work", getOwner: () => cleanupOwner,
      canAdoptFence: () => false, getNowMs: () => 100,
      async revalidateUnderFence() { return true; } });
    let deletes = 0;
    const port = createTelegramInactiveThreadCleanupSettingsPort({ store, permitRuntime,
      async resolveFullBinding() { return binding; }, async deleteWithPermit() { deletes += 1; },
      async commitBinding() { return true; } });
    failAfterRename = true;
    assert.deepEqual(await port(operationId),
      { deleted: 0, outcomeUnknown: 1, blocked: 0, recovery: "commit-ready" });
    assert.equal(store.list()[0]?.entries[0]?.state, "deleted");
    assert.equal(ledger.read().fence?.phase, "commit-ready");
    assert.deepEqual(await port(operationId), { deleted: 1, outcomeUnknown: 0, blocked: 0 });
    assert.equal(deletes, 1);
    assert.equal(ledger.read().fence, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cross-process cleanup contenders issue one fake transport deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-race-"));
  try {
    const operationId = `thread-cleanup:${"d".repeat(32)}`;
    const workPath = join(dir, "work.json");
    const ledgerPath = join(dir, "ledger.json");
    const markerPath = join(dir, "deleted");
    const attemptDir = join(dir, "attempts");
    await mkdir(attemptDir);
    const candidate = planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    createTelegramThreadCleanupWorkStore({ path: workPath, profileName: "work",
      tokenSha256: "a".repeat(64) }).prepare(operationId, [candidate]);
    const worker = join(import.meta.dirname, "fixtures", "thread-cleanup-worker.ts");
    const args = ["--experimental-strip-types", worker, workPath, ledgerPath, markerPath,
      attemptDir, operationId, JSON.stringify(candidate)];
    const results = await Promise.all([
      execFileAsync(process.execPath, args), execFileAsync(process.execPath, args),
    ]);
    assert.equal(results.length, 2);
    assert.equal((await readdir(attemptDir)).length, 1);
    const restored = createTelegramThreadCleanupWorkStore({ path: workPath,
      profileName: "work", tokenSha256: "a".repeat(64) });
    assert.equal(restored.list()[0]?.entries[0]?.state, "deleted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup work-set records one exact deletion permit across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-"));
  const path = join(dir, "cleanup.json");
  let now = 100;
  try {
    const candidate = planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    const store = createTelegramThreadCleanupWorkStore({ path, profileName: "work",
      tokenSha256: "a".repeat(64), getNowMs: () => now });
    assert.equal(store.prepare("cleanup-1", [candidate]).prepared, true);
    assert.equal(store.prepare("cleanup-1", [candidate]).prepared, false);
    now = 110;
    const permit = { destructiveKind: "manual-thread-cleanup" as const,
      operationId: "permit-op", retirementIntentId: "cleanup-1",
      profileKey: "work", bindingKey: "binding:a", slot: "A",
      target: { chatId: -1001, threadId: 7 }, leaderEpoch: 3, issuedAtMs: 105 };
    assert.equal(store.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a",
      bindingUpdatedAtMs: 20, permit }).recorded, true);
    const restarted = createTelegramThreadCleanupWorkStore({ path, profileName: "work",
      tokenSha256: "a".repeat(64), getNowMs: () => now });
    assert.equal(restarted.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a",
      bindingUpdatedAtMs: 20, permit }).recorded, false);
    assert.throws(() => restarted.recordDeletionIssued({ operationId: "cleanup-1",
      bindingKey: "binding:a", bindingUpdatedAtMs: 20,
      permit: { ...permit, operationId: "foreign-permit" } }), /conflicts/u);
    now = 120;
    assert.equal(restarted.confirmDeleted({ operationId: "cleanup-1", bindingKey: "binding:a" }).confirmed, true);
    assert.equal(restarted.confirmDeleted({ operationId: "cleanup-1", bindingKey: "binding:a" }).confirmed, false);
    await rm(path);
    await symlink("/etc/passwd", path);
    assert.throws(() => restarted.list(), /bounded private regular file/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup execution revalidates and consumes one permit inside admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-cleanup-execute-"));
  const path = join(dir, "cleanup.json");
  try {
    const candidate = planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    const store = createTelegramThreadCleanupWorkStore({ path, profileName: "work",
      tokenSha256: "a".repeat(64) });
    store.prepare("execute", [candidate]);
    const events: string[] = [];
    const result = await executeTelegramInactiveThreadCleanup({
      store, operationId: "execute", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) {
        events.push("boundary:start");
        try { return await operation(); } finally { events.push("boundary:end"); }
      },
      async loadFreshEvidence() {
        events.push("evidence");
        return { profileName: "work", bindings: [binding], protection: [clear] };
      },
      async acquireDeletionPermit() {
        events.push("permit");
        return { kind: "issued", permit: { destructiveKind: "manual-thread-cleanup" as const,
          operationId: "permit", retirementIntentId: "execute",
          profileKey: "work", bindingKey: "binding:a", slot: "A", target: binding.target,
          leaderEpoch: 1, issuedAtMs: Date.now() } };
      },
      async deleteWithPermit() { events.push("delete"); },
    });
    assert.equal(result.status, "deleted");
    assert.deepEqual(events, ["boundary:start", "evidence", "permit", "delete", "boundary:end"]);
    const replay = await executeTelegramInactiveThreadCleanup({
      store, operationId: "execute", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) { return operation(); },
      async loadFreshEvidence() { throw new Error("must not revalidate deleted work"); },
      async acquireDeletionPermit() { throw new Error("must not reacquire permit"); },
      async deleteWithPermit() { throw new Error("must not replay delete"); },
    });
    assert.equal(replay.status, "deleted");

    store.prepare("ambiguous", [candidate]);
    let deletes = 0;
    const ambiguousInput = {
      store, operationId: "ambiguous", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary<T>(operation: () => Promise<T>) { return operation(); },
      async loadFreshEvidence() {
        return { profileName: "work", bindings: [binding], protection: [clear] };
      },
      async acquireDeletionPermit() {
        return { kind: "issued" as const, permit: { destructiveKind: "manual-thread-cleanup" as const,
          operationId: "permit-2", retirementIntentId: "ambiguous", profileKey: "work", bindingKey: "binding:a",
          slot: "A", target: binding.target, leaderEpoch: 1, issuedAtMs: Date.now() } };
      },
      async deleteWithPermit() { deletes += 1; throw new Error("lost delete response"); },
    };
    await assert.rejects(executeTelegramInactiveThreadCleanup(ambiguousInput));
    assert.equal((await executeTelegramInactiveThreadCleanup(ambiguousInput)).status, "outcome-unknown");
    assert.equal(deletes, 1);

    store.prepare("drift", [candidate]);
    let permitCalls = 0;
    const drift = await executeTelegramInactiveThreadCleanup({
      store, operationId: "drift", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) { return operation(); },
      async loadFreshEvidence() {
        return { profileName: "work", bindings: [{ ...binding, updatedAtMs: 21 }], protection: [clear] };
      },
      async acquireDeletionPermit() { permitCalls += 1; return { kind: "blocked" as const }; },
      async deleteWithPermit() { throw new Error("must not delete drifted binding"); },
    });
    assert.equal(drift.status, "blocked");
    assert.equal(permitCalls, 0);

    store.prepare("already-issued", [candidate]);
    const issued = await executeTelegramInactiveThreadCleanup({
      store, operationId: "already-issued", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) { return operation(); },
      async loadFreshEvidence() {
        return { profileName: "work", bindings: [binding], protection: [clear] };
      },
      async acquireDeletionPermit() { return { kind: "already-issued" as const }; },
      async deleteWithPermit() { throw new Error("must not replay an issued permit"); },
    });
    assert.equal(issued.status, "blocked");
    assert.equal(store.list().find(workSet => workSet.operationId === "already-issued")
      ?.entries[0]?.state, "prepared");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup planner refuses competing work and identity ambiguity", () => {
  for (const field of ["reservedTargets", "provisioningTargets", "cleanupTargets"] as const) {
    assert.deepEqual(planTelegramInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear], [field]: [binding.target],
    }), []);
  }
  assert.deepEqual(planTelegramInactiveThreadCleanup({
    profileName: "work", bindings: [binding, { ...binding, bindingKey: "binding:b" }],
    protection: [clear],
  }), []);
  assert.deepEqual(planTelegramInactiveThreadCleanup({
    profileName: "work", bindings: [binding], protection: [clear, clear],
  }), []);
});
