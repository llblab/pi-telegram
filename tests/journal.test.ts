/**
 * Durable Telegram inbound update journal regressions
 * Zones: telegram inbound, filesystem authority, crash recovery
 * Covers schema, identity, dedupe, capacity, atomic publication, and cross-process serialization
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createTelegramBusFollowerDeliveryIdentity, createTelegramBusFollowerRegistry,
  createTelegramBusForeignOwnedUpdateForwarder, createTelegramBusProtocolIdentity,
  getTelegramInputCustodyPeerReadiness, getTelegramProcessBirthIdentity,
  sendTelegramBusLocalEnvelope, TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE } from "../lib/bus.ts";
import { createTelegramBusFollowerSourceReferenceAdmissionRuntime,
  createTelegramBusForwardedUpdateReceiverRuntime } from "../lib/bus-follower.ts";
import { createTelegramConfigStore } from "../lib/config.ts";
import {
  createTelegramUpdateJournalBindingKey,
  createTelegramUpdateJournalBindingRuntime,
  createTelegramUpdateJournalLegacyCustodyEvidence,
  normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority,
  createTelegramUpdateJournalBotIdentity,
  createTelegramUpdateQueueHandoffToken,
  discoverTelegramFollowerJournalPaths,
  inspectTelegramUpdateJournalFamily,
  inspectTelegramInputCustodySourceStatus,
  readTelegramUpdateJournalSource,
  inspectTelegramProfileJournalNamespace,
  createTelegramUpdateJournalReceiptScope,
  createTelegramUpdateJournalReceiptScopeResolver,
  createTelegramUpdateJournalRuntimeBindingResolver,
  createTelegramUpdateJournalReferenceRegistry,
  getTelegramUpdateJournalBindingPath,
  publishTelegramUpdateJournalSegment,
  TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES,
  TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT,
  createTelegramUpdateJournalStore,
  createTelegramInputJournalStore,
  type TelegramInputJournalStoreOptions,
  type TelegramUpdateJournalQueueOwnerIdentity,
  getTelegramUpdateJournalAdmissionScopes,
  TelegramUpdateJournalError,
  type TelegramJournaledUpdate,
  type TelegramUpdateJournalStoreOptions,
} from "../lib/journal.ts";
import {
  createTelegramWorkspaceAdmissionLedger,
  TelegramWorkspaceAdmissionError,
  type TelegramWorkspaceAdmissionLedger,
} from "../lib/workspace-admission.ts";
import { createTelegramCustodiedExecutionSession,
  createTelegramCustodiedUpdateAdmissionHandle,
  createTelegramInputCustodyLifecycleBindingResolver,
  createTelegramInputCustodyLegacyDispositionRuntime,
  createTelegramInputCustodyBusBindingRuntime,
  createTelegramInputCustodyForwardReferenceResolver,
  createTelegramInputCustodyHandoffAcceptanceRuntime,
  createTelegramInputCustodyHandoffClient,
  createTelegramInputCustodySourceReferenceWakeRuntime,
  createTelegramInputCustodyWorkerJournalPort,
  evaluateTelegramInputCustodyActivationReadiness,
  evaluateTelegramInputCustodyWriterExclusionEvidence,
  executeTelegramInputCustodyWriterCutover,
  executeTelegramInputCustodyMigrationCompletion,
  normalizeTelegramInputCustodyStartupExclusionAuthority,
  normalizeTelegramInputCustodyMigrationCompletionAuthority,
  createTelegramInputCustodyActivationReadinessResolver,
  createTelegramInputCustodyProvenReadinessResolver,
  createTelegramInputCustodyReadinessEvidenceStore,
  createTelegramUpdateAdmissionLifecycleAssembly,
  createTelegramUpdateAdmissionLifecycleRuntime,
  createTelegramUpdateAdmissionRuntimeBinding,
  createTelegramUpdateAdmissionWorkerRuntime, executeTelegramCustodiedInput,
  reportTelegramQueueAdmission, reportTelegramUpdateCompleted,
  reportTelegramUpdateDeferred } from "../lib/updates.ts";

const workerPath = fileURLToPath(
  new URL("./fixtures/journal-worker.ts", import.meta.url),
);

test("Legacy custody disposition authority binds immutable quarantined failure evidence", () => {
  const entry = { updateId: 7, update: { update_id: 7 }, admittedAtMs: 100,
    state: "retry-wait" as const, failure: { attemptCount: 2, failedAtMs: 200,
      failureClass: "transport", summary: "retry later" }, nextRetryAtMs: 300 };
  const evidence = createTelegramUpdateJournalLegacyCustodyEvidence(entry);
  assert.ok(evidence);
  assert.match(evidence.evidenceSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(createTelegramUpdateJournalLegacyCustodyEvidence({ ...entry,
    failure: { ...entry.failure, summary: "changed" } })?.evidenceSha256,
  evidence.evidenceSha256);
  const authority = { version: 1 as const, dispositionId: "legacy-disposition:1",
    updateId: 7, evidenceSha256: evidence.evidenceSha256, action: "requeue-v3" as const,
    operatorAuthorityId: "operator:1", authorizedAtMs: 400 };
  assert.deepEqual(normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(authority,
    evidence), authority);
  assert.equal(normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority({ ...authority,
    updateId: 8 }, evidence), undefined);
  assert.equal(normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority({ ...authority,
    action: "retry" }, evidence), undefined);
  assert.equal(normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority({ ...authority,
    target: { chatId: 1 } }, evidence), undefined);
  assert.equal(createTelegramUpdateJournalLegacyCustodyEvidence({ ...entry,
    inputClaim: { phase: "running" } } as never), undefined);
});

test("V3 legacy custody disposition atomically requeues or discards with audit", async context => {
  await withInputCustodyFixture(context, async ({ path, options, setHook }) => {
    const retryEntry = { updateId: 7, update: { update_id: 7 }, admittedAtMs: 100,
      preApprovalExcluded: false, state: "retry-wait" as const,
      failure: { attemptCount: 2, failedAtMs: 200, failureClass: "transport",
        summary: "retry later" }, nextRetryAtMs: 300 };
    const failedEntry = { updateId: 8, update: { update_id: 8 }, admittedAtMs: 110,
      preApprovalExcluded: false, state: "failed" as const,
      failure: { attemptCount: 3, failedAtMs: 210, failureClass: "handler",
        summary: "terminal" }, terminalAtMs: 220, terminalReason: "attempt-limit",
      terminalFailureId: "failure-terminal-8" };
    writeFileSync(path, `${JSON.stringify({ version: 3,
      acceptedThroughUpdateId: 8, profile: "work",
      botIdentity: options.botIdentity, entries: [retryEntry, failedEntry] })}\n`);
    let authorized = true;
    const authorizationKeys: string[][] = [];
    const store = createTelegramInputJournalStore({ ...options, getNowMs: () => 500,
      authorizeLegacyCustodyDisposition: authority => {
        authorizationKeys.push(Object.keys(authority).sort());
        return authorized;
      } });
    const inspector = createTelegramInputJournalStore({ ...options,
      withSourceSerialization() { throw new Error("candidate listing entered mutation serialization"); } });
    const candidates = inspector.listLegacyCustodyCandidates();
    assert.deepEqual(candidates.map(candidate => candidate.updateId), [7, 8]);
    assert.deepEqual(Object.keys(candidates[0]!).sort(),
      ["attemptCount", "evidenceSha256", "failureClass", "state", "updateId"]);
    const retryEvidence = createTelegramUpdateJournalLegacyCustodyEvidence(retryEntry)!;
    const retryAuthority = { version: 1 as const, dispositionId: "legacy:retry:7",
      updateId: 7, evidenceSha256: retryEvidence.evidenceSha256, action: "requeue-v3" as const,
      operatorAuthorityId: "operator:1", authorizedAtMs: 400 };
    let boundaries = 0;
    setHook(boundary => {
      boundaries += 1;
      if (boundaries === 3 && boundary === "before-write")
        throw new Error("legacy disposition snapshot commit unknown");
    });
    assert.throws(() => store.applyLegacyCustodyDisposition(retryAuthority),
      error => isJournalError(error, "io"));
    setHook(undefined);
    assert.equal(store.read().entries.find(entry => entry.updateId === 7)?.state, "pending");
    assert.equal(store.applyLegacyCustodyDisposition(retryAuthority).duplicate, true);
    assert.deepEqual(authorizationKeys[1], ["action", "authorizedAtMs", "dispositionId",
      "evidenceSha256", "operatorAuthorityId", "updateId", "version"]);
    const callsBeforeMalformedDuplicate = authorizationKeys.length;
    assert.throws(() => store.applyLegacyCustodyDisposition({ ...retryAuthority,
      extraAuthority: "must-not-reach-authorizer" } as never), /another authority/);
    assert.equal(authorizationKeys.length, callsBeforeMalformedDuplicate);
    assert.throws(() => store.applyLegacyCustodyDisposition({ ...retryAuthority,
      dispositionId: "legacy:retry:7:again" }), /non-quarantined/);
    const failedEvidence = createTelegramUpdateJournalLegacyCustodyEvidence(failedEntry)!;
    const discardAuthority = { version: 1 as const, dispositionId: "legacy:discard:8",
      updateId: 8, evidenceSha256: failedEvidence.evidenceSha256, action: "discard" as const,
      operatorAuthorityId: "operator:1", authorizedAtMs: 410 };
    authorized = false;
    assert.throws(() => store.applyLegacyCustodyDisposition(discardAuthority), /unauthorized/);
    authorized = true;
    assert.equal(store.applyLegacyCustodyDisposition(discardAuthority).duplicate, false);
    const snapshot = store.read();
    assert.equal(snapshot.entries.some(entry => entry.updateId === 8), false);
    assert.deepEqual(snapshot.operatorDispositions?.map(disposition => disposition.failureId),
      ["legacy:retry:7", "legacy:discard:8"]);
  });
});

test("Follower journal discovery is profile-exact, segment-aware, and fail-closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-journal-discovery-"));
  try {
    const defaultA = join(dir, "follower-inbox-aaaaaaaaaaaaaaaa.json");
    const defaultB = join(dir, "follower-inbox-bbbbbbbbbbbbbbbb.json");
    const namedC = join(dir, "follower-inbox-cccccccccccccccc.work.json");
    await writeFile(defaultA, "{}\n");
    await mkdir(`${defaultA}.segments`);
    await mkdir(`${defaultB}.segments`);
    await writeFile(namedC, "{}\n");
    await mkdir(join(dir, "follower-inbox-dddddddddddddddd.json"));
    await writeFile(join(dir, "follower-inbox-not-a-hash.json"), "{}\n");
    assert.deepEqual(discoverTelegramFollowerJournalPaths({ directory: dir }), {
      paths: [defaultA, defaultB], complete: false,
    });
    assert.deepEqual(discoverTelegramFollowerJournalPaths({ directory: dir, profileName: "work" }), {
      paths: [namedC], complete: true,
    });
    assert.deepEqual(discoverTelegramFollowerJournalPaths({
      directory: join(dir, "missing"), profileName: "work",
    }), { paths: [], complete: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function assertUnsupportedStrictInspection(
  input: Parameters<typeof inspectTelegramUpdateJournalFamily>[0],
  context: TestContext,
  inspect: () => unknown = () => inspectTelegramUpdateJournalFamily(input),
): boolean {
  if (fs.constants.O_NOFOLLOW && fs.constants.O_NONBLOCK) return false;
  assert.throws(inspect, (error) =>
    isJournalError(error, "invalid") && /platform lacks no-follow nonblocking open evidence/.test((error as Error).message));
  context.diagnostic("Open flags unavailable: fail-closed refusal verified; successful decoding not exercised.");
  return true;
}

async function withInputCustodyFixture(context: TestContext,
  run: (fixture: {
    path: string; dir: string; options: TelegramInputJournalStoreOptions;
    setOwner: (owner: TelegramUpdateJournalQueueOwnerIdentity | undefined) => void;
    setBinding: (binding: string) => void;
    setHook: (hook: TelegramUpdateJournalStoreOptions["onPublicationBoundary"]) => void;
    ledger: ReturnType<typeof createTelegramWorkspaceAdmissionLedger>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-input-custody-")));
  const path = join(dir, "inbox.work.json");
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "123:synthetic-input-custody" });
  const configPath = join(dir, "telegram.json");
  try {
    await writeFile(configPath, JSON.stringify({ profiles: { work: { botToken: "123:synthetic-input-custody", allowedUserId: 7 } } }));
    const config = createTelegramConfigStore({ agentDir: dir, configPath });
    await config.load(); config.activateProfile("work");
    const runtime = { instanceId: "owner", processId: process.pid, processBirthId: `${process.pid}:fixture-birth` };
    let owner: TelegramUpdateJournalQueueOwnerIdentity | undefined = { ...runtime, sessionGeneration: 1 };
    let recipientBindingKey = "workspace:owner";
    let held = false;
    let hook: TelegramUpdateJournalStoreOptions["onPublicationBoundary"];
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "workspace-admission.json"),
      profileKey: "fixture:work", owner: { processId: runtime.processId, processBirthId: runtime.processBirthId },
      getProcessLiveness: () => "alive" });
    const options: TelegramInputJournalStoreOptions = {
      path, profileName: "work", botIdentity, queueRuntimeIdentity: runtime, workspaceAdmission: ledger,
      sourceAccess: { directory: dir, limits: { maxFiles: 1000, maxBytes: 10_000_000, maxEntries: 100, maxWork: 100_000 } },
      withSourceSerialization(operation) {
        assert.equal(existsSync(`${path}.transaction`), false);
        return config.withSourceSerialization(() => { held = true; try { return operation(); } finally { held = false; } });
      },
      withPairingAdmission(publish) {
        assert.ok(ledger.read().leases.length > 0);
        return config.withPairingAdmission("work", botIdentity.tokenSha256, excluded => {
          held = true; try { return publish(excluded); } finally { held = false; }
        });
      },
      getInputContext() {
        assert.equal(held, true);
        assert.ok(ledger.read().leases.some(lease => lease.scope.kind === "profile"));
        return owner ? { owner, recipientBindingKey } : undefined;
      },
      onPublicationBoundary(boundary, target) {
        assert.equal(held, true);
        assert.ok(ledger.read().leases.length > 0);
        hook?.(boundary, target);
      },
    };
    if (assertUnsupportedStrictInspection({ ...options.sourceAccess, path, profile: "work", botIdentity }, context,
      () => createTelegramInputJournalStore(options).read())) return;
    await run({ path, dir, options, ledger, setOwner: value => { owner = value; },
      setBinding: value => { recipientBindingKey = value; }, setHook: value => { hook = value; } });
    assert.deepEqual(ledger.read().leases, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function inputSource(receipt: {
  journalBindingKey: string;
  tokenSha256: string;
  updateId: number;
}) {
  return { journalBindingKey: receipt.journalBindingKey,
    tokenSha256: receipt.tokenSha256, updateId: receipt.updateId };
}

test("Input custody acquires once, fences start and settlement, and preserves exact old receipts", async context => {
  await withInputCustodyFixture(context, async ({ options, setOwner, setBinding, ledger }) => {
    const store = createTelegramInputJournalStore(options);
    assert.equal("removeCompleted" in store, false);
    assert.equal("markQueued" in store, false);
    assert.equal("acquireInput" in createTelegramUpdateJournalStore(options), false);
    store.appendBatch([{ update_id: 10 }, { update_id: 20, message: { text: "original" } }], 20);
    const request = { updateId: 20, recipientBindingKey: "workspace:owner",
      executionUpdate: { update_id: 20, message: { text: "routed", message_thread_id: 9 } } };
    const first = store.acquireInput(request);
    assert.equal(first.acquired, true);
    assert.deepEqual(ledger.read().leases, []);
    assert.throws(() => store.completeInput(first.receipt), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(createTelegramInputJournalStore(options).acquireInput(request), { acquired: false, receipt: first.receipt });
    assert.throws(() => store.acquireInput({ ...request, recipientBindingKey: "another" }), (error) => isJournalError(error, "conflict"));
    assert.throws(() => store.acquireInput({ ...request, executionUpdate: undefined }), (error) => isJournalError(error, "conflict"));
    const second = store.acquireInput({ updateId: 10, recipientBindingKey: "workspace:owner" });
    assert.notEqual(second.receipt.owner.acquisitionId, first.receipt.owner.acquisitionId);
    const identity = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    setOwner({ ...identity, sessionGeneration: 2 });
    assert.throws(() => store.startInput(first.receipt), (error) => isJournalError(error, "conflict"));
    assert.throws(() => store.acquireInput(request), (error) => isJournalError(error, "conflict"));
    setOwner(identity);
    setBinding("workspace:replacement");
    assert.throws(() => store.startInput(first.receipt), (error) => isJournalError(error, "conflict"));
    setBinding("workspace:owner");
    for (const changed of [
      { ...first.receipt, journalBindingKey: first.receipt.journalBindingKey + "wrong" },
      { ...first.receipt, updateId: 10 },
      { ...first.receipt, owner: { ...first.receipt.owner, acquisitionId: "stale" } },
      { ...first.receipt, owner: { ...first.receipt.owner, processBirthId: "foreign" } },
    ]) assert.throws(() => store.startInput(changed), (error) => isJournalError(error, "conflict"));
    const started = store.startInput(first.receipt);
    assert.deepEqual(started, { started: true, update: request.executionUpdate });
    if (started.started) (started.update.message as { text: string }).text = "caller mutation";
    assert.deepEqual(createTelegramInputJournalStore(options).startInput(first.receipt), { started: false });
    assert.equal((store.read().entries[1]!.inputClaim!.executionUpdate!.message as { text: string }).text, "routed");
    const foreign = { instanceId: "foreign", processId: process.pid + 1, processBirthId: "foreign-birth" };
    const other = createTelegramInputJournalStore({ ...options, queueRuntimeIdentity: foreign,
      getInputContext: () => ({ owner: { ...foreign, sessionGeneration: 1 }, recipientBindingKey: "workspace:owner" }) });
    assert.throws(() => other.acquireInput({ updateId: 10, recipientBindingKey: "workspace:owner" }), (error) => isJournalError(error, "conflict"));
    assert.throws(() => other.completeInput(first.receipt), (error) => isJournalError(error, "conflict"));
    // Settlement preserves its exact acquired authority after the originating session disappears.
    setOwner(undefined);
    assert.deepEqual(store.completeInput(first.receipt).removedUpdateIds, [20]);
    assert.deepEqual(store.completeInput(first.receipt).removedUpdateIds, []);
    assert.deepEqual(store.appendBatch([{ update_id: 20 }], 20).addedUpdateIds, []);
    setOwner(identity);
    assert.throws(() => store.acquireInput(request), (error) => isJournalError(error, "conflict"));
    assert.equal(store.startInput(second.receipt).started, true);
    assert.deepEqual(store.completeInput(second.receipt).removedUpdateIds, [10]);
    assert.deepEqual(store.read().entries, []);
  });
});

test("V3 activation readiness fails closed on mixed startup evidence", () => {
  const ready = { requested: true, sourceStatus: "v3" as const,
    legacyWritersExcluded: true, historicalMigrationComplete: true,
    peerReadiness: ["ready"] as const };
  assert.deepEqual(evaluateTelegramInputCustodyActivationReadiness(ready), { enabled: true });
  assert.deepEqual(evaluateTelegramInputCustodyActivationReadiness({ ...ready,
    sourceStatus: "absent" }), { enabled: true });
  const cases = [
    [{ ...ready, requested: false }, "disabled"],
    [{ ...ready, legacyWritersExcluded: false }, "legacy-writers-present"],
    [{ ...ready, historicalMigrationComplete: false }, "migration-incomplete"],
    [{ ...ready, sourceStatus: "legacy" as const }, "source-unready"],
    [{ ...ready, sourceStatus: "unsupported" as const }, "source-unready"],
    [{ ...ready, sourceStatus: "ambiguous" as const }, "source-unready"],
    [{ ...ready, peerReadiness: ["ready", "legacy"] as const }, "peer-capability-mismatch"],
    [{ ...ready, peerReadiness: ["unknown"] as const }, "peer-capability-mismatch"],
  ] as const;
  for (const [input, blocker] of cases) assert.deepEqual(
    evaluateTelegramInputCustodyActivationReadiness(input), { enabled: false, blocker });
});

test("Legacy journal mutations honor the optional outer writer admission fence", async context => {
  await withInputCustodyFixture(context, async ({ options, path }) => {
    const { onPublicationBoundary: _boundary, ...base } = options;
    let allowed = false;
    let admissions = 0;
    const order: string[] = [];
    const store = createTelegramUpdateJournalStore({ ...base,
      withWriterAdmission(operation) {
        admissions += 1;
        order.push("writer-admission");
        if (!allowed) throw new Error("writer fence closed");
        return operation();
      },
      withSourceSerialization(operation) {
        order.push("source-serialization");
        return base.withSourceSerialization!(operation);
      },
      withPairingAdmission(publish) {
        order.push("pairing-serialization");
        return base.withPairingAdmission!(publish);
      },
    });
    assert.throws(() => store.appendBatch([{ update_id: 1 }], 1), /writer fence closed/);
    assert.equal(existsSync(path), false);
    assert.deepEqual(order, ["writer-admission"]);
    order.length = 0;
    allowed = true;
    assert.deepEqual(store.appendBatch([{ update_id: 1 }], 1).addedUpdateIds, [1]);
    assert.deepEqual(order, ["writer-admission", "pairing-serialization"]);
    allowed = false;
    assert.throws(() => store.removeCompleted([1]), /writer fence closed/);
    assert.throws(() => store.read(), /writer fence closed/);
    allowed = true;
    assert.deepEqual(store.read().entries.map(entry => entry.updateId), [1]);
    assert.equal(admissions, 5);
  });
});

test("V3 source readiness adapter observes absent then strict v3 family", async context => {
  await withInputCustodyFixture(context, async ({ options, path }) => {
    const inspection = { ...options.sourceAccess, path,
      profile: options.profileName!, botIdentity: options.botIdentity };
    const registry = createTelegramBusFollowerRegistry();
    const readyProtocol = createTelegramBusProtocolIdentity({ runtimeBuild: "0.45.0",
      capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
        TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE] });
    registry.register({ instanceId: "peer", registrationGeneration: "g1",
      protocol: readyProtocol, connectedAtMs: 1 });
    const resolve = createTelegramInputCustodyActivationReadinessResolver({
      isRequested: () => true,
      inspectSource: () => inspectTelegramInputCustodySourceStatus(inspection),
      areLegacyWritersExcluded: () => true,
      isHistoricalMigrationComplete: () => true,
      listPeerReadiness: () => getTelegramInputCustodyPeerReadiness(registry.list()),
    });
    assert.equal(inspectTelegramInputCustodySourceStatus(inspection), "absent");
    assert.deepEqual(resolve(), { enabled: true });
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 1 }], 1);
    assert.equal(inspectTelegramInputCustodySourceStatus(inspection), "v3");
    assert.deepEqual(resolve(), { enabled: true });
    registry.register({ instanceId: "peer", registrationGeneration: "g1",
      protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "0.44.0",
        capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] }), connectedAtMs: 2 });
    assert.deepEqual(resolve(), { enabled: false, blocker: "peer-capability-mismatch" });
    registry.register({ instanceId: "peer", registrationGeneration: "g2",
      protocol: readyProtocol, connectedAtMs: 3 });
    assert.deepEqual(resolve(), { enabled: true });
    await writeFile(path, "{broken");
    assert.equal(inspectTelegramInputCustodySourceStatus(inspection), "ambiguous");
    assert.deepEqual(resolve(), { enabled: false, blocker: "source-unready" });
  });
});

test("Journal reference registry bounds and exactly releases process-local leases", async () => {
  const registry = createTelegramUpdateJournalReferenceRegistry({ maxActive: 2 });
  const releaseLeader = registry.acquire({ referenceClass: "leader-lifecycle",
    recoveryKey: "journal:leader" });
  const releasePolling = registry.acquire({ referenceClass: "polling-cursor",
    recoveryKey: "journal:leader" });
  assert.deepEqual(registry.list(), [
    { referenceClass: "leader-lifecycle", recoveryKey: "journal:leader" },
    { referenceClass: "polling-cursor", recoveryKey: "journal:leader" },
  ]);
  assert.throws(() => registry.acquire({ referenceClass: "polling-bootstrap",
    recoveryKey: "journal:leader" }), /unavailable or full/);
  releasePolling();
  assert.throws(releasePolling, /lease is stale/);
  releaseLeader();
  assert.deepEqual(registry.list(), []);
  const releaseOperator = registry.acquire({ referenceClass: "operator-disposition",
    recoveryKey: "journal:leader" });
  assert.deepEqual(registry.list(), [
    { referenceClass: "operator-disposition", recoveryKey: "journal:leader" },
  ]);
  releaseOperator();
  assert.deepEqual(registry.list(), []);
  let rejectOperation!: (error: Error) => void;
  const pending = registry.withReference({ referenceClass: "polling-bootstrap",
    recoveryKey: "journal:leader" }, () => new Promise<void>((_resolve, reject) => {
      rejectOperation = reject;
    }));
  assert.deepEqual(registry.list(), [
    { referenceClass: "polling-bootstrap", recoveryKey: "journal:leader" },
  ]);
  rejectOperation(new Error("operation failed"));
  await assert.rejects(pending, /operation failed/);
  assert.deepEqual(registry.list(), []);
});

test("V3 migration completion authority binds cutover and historical inventory", () => {
  const expected = { profileKey: "profile:work", recoveryKey: "journal:work" };
  const authority = { version: 1 as const, status: "authorized" as const,
    authorityId: "migration:1", startupAuthorityId: "operator-cutover:1",
    closureOperationId: "closure:1", ...expected,
    migrationInventorySha256: "b".repeat(64), resultingSourceFamily: "v3" as const,
    authorizedAtMs: 1_000 };
  assert.deepEqual(normalizeTelegramInputCustodyMigrationCompletionAuthority(authority, expected),
    authority);
  assert.equal(normalizeTelegramInputCustodyMigrationCompletionAuthority({ ...authority,
    recoveryKey: "journal:other" }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyMigrationCompletionAuthority({ ...authority,
    resultingSourceFamily: "legacy" }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyMigrationCompletionAuthority({ ...authority,
    migrationInventorySha256: "raw inventory" }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyMigrationCompletionAuthority({ ...authority,
    retryDisposition: "discard" }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyMigrationCompletionAuthority({ ...authority,
    status: "revoked" }, expected)?.status, "revoked");
});

test("V3 migration completion publication is exact and idempotent", () => {
  const expected = { profileKey: "profile:work", recoveryKey: "journal:work" };
  const digest = "b".repeat(64);
  const authority = { version: 1 as const, status: "authorized" as const,
    authorityId: "migration:1", startupAuthorityId: "operator-cutover:1",
    closureOperationId: "closure:1", ...expected, migrationInventorySha256: digest,
    resultingSourceFamily: "v3" as const, authorizedAtMs: 1_000 };
  let retained: string | undefined;
  const store = createTelegramInputCustodyReadinessEvidenceStore({
    readRetained: () => retained, publishRetained(value) { retained = value; },
    withSerialization: operation => operation(), authorizePublication: () => true });
  store.publish({ expectedRevision: 0, kind: "migration-completion", evidence: authority });
  let source: "absent" | "v3" = "v3";
  const run = (migrationInventorySha256 = digest) =>
    executeTelegramInputCustodyMigrationCompletion({ expected, authority,
      migrationInventorySha256, inspectSource: () => source, evidenceStore: store });
  assert.deepEqual(run("c".repeat(64)), { kind: "blocked", blocker: "inventory-drift" });
  source = "absent";
  assert.deepEqual(run(), { kind: "blocked", blocker: "source-drift" });
  source = "v3";
  const completed = run();
  assert.equal(completed.kind, "completed");
  if (completed.kind === "completed") assert.equal(completed.resumed, false);
  const revision = store.read().revision;
  const resumed = run();
  assert.equal(resumed.kind, "completed");
  if (resumed.kind === "completed") assert.equal(resumed.resumed, true);
  assert.equal(store.read().revision, revision);
  store.publish({ expectedRevision: revision, kind: "migration-completion",
    evidence: { ...authority, status: "revoked" } });
  assert.deepEqual(run(), { kind: "blocked", blocker: "migration-authority" });
});

test("V3 startup exclusion authority binds closure, inventory, identity, and protocol", () => {
  const expected = { profileKey: "profile:work", recoveryKey: "journal:work" };
  const authority = { version: 1 as const, status: "enforced" as const,
    authorityId: "operator-cutover:1", closureOperationId: "closure:1", ...expected,
    writerInventorySha256: "a".repeat(64), allowedWriterProtocol: "custody-v3" as const,
    authorizedAtMs: 1_000 };
  assert.deepEqual(normalizeTelegramInputCustodyStartupExclusionAuthority(authority, expected), authority);
  assert.equal(normalizeTelegramInputCustodyStartupExclusionAuthority({ ...authority,
    recoveryKey: "journal:other" }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyStartupExclusionAuthority({ ...authority,
    writerInventorySha256: "raw inventory" }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyStartupExclusionAuthority({ ...authority,
    allowedWriterProtocol: "legacy" }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyStartupExclusionAuthority({ ...authority,
    target: { chatId: 1 } }, expected), undefined);
  assert.equal(normalizeTelegramInputCustodyStartupExclusionAuthority({ ...authority,
    status: "revoked" }, expected)?.status, "revoked");
});

test("V3 writer exclusion requires complete inventory and proven process death", () => {
  const expected = { profileKey: "profile:work", recoveryKey: "journal:work" };
  const writers = [{ processId: 11, processBirthId: "11:start:a" },
    { processId: 12, processBirthId: "12:start:b" }];
  const digest = "a".repeat(64);
  const startupAuthority = { version: 1 as const, status: "enforced" as const,
    authorityId: "operator-cutover:1", closureOperationId: "closure:1", ...expected,
    writerInventorySha256: digest, allowedWriterProtocol: "custody-v3" as const,
    authorizedAtMs: 1_000 };
  const evaluate = (complete: boolean, states: Record<number, "alive" | "dead" | "unverifiable">,
    identity = expected,
    authority: Parameters<typeof evaluateTelegramInputCustodyWriterExclusionEvidence>[0]["startupAuthority"] = startupAuthority) =>
    evaluateTelegramInputCustodyWriterExclusionEvidence({ expected,
      inventory: { ...identity, complete, writers, writerInventorySha256: digest },
      startupAuthority: authority,
      getProcessLiveness: writer => states[writer.processId] ?? "unverifiable" });
  assert.equal(evaluate(false, { 11: "dead", 12: "dead" }).status, "unknown");
  assert.equal(evaluate(true, { 11: "dead", 12: "dead" },
    { ...expected, recoveryKey: "journal:other" }).status, "unknown");
  assert.equal(evaluate(true, { 11: "dead", 12: "unverifiable" }).status, "unknown");
  assert.equal(evaluate(true, { 11: "dead", 12: "alive" }).status, "present");
  assert.equal(evaluate(true, { 11: "dead", 12: "dead" }, expected,
    { ...startupAuthority, status: "revoked" }).status, "unknown");
  assert.deepEqual(evaluate(true, { 11: "dead", 12: "dead" }), {
    version: 1, status: "excluded", ...expected, startupAuthorityId: "operator-cutover:1",
    closureOperationId: "closure:1", writerInventorySha256: digest });
});

test("V3 readiness evidence store serializes authorized exact-revision proofs", () => {
  let retained: string | undefined;
  let authorized = true;
  const authorizedEvidenceKeys: string[][] = [];
  const store = createTelegramInputCustodyReadinessEvidenceStore({
    readRetained: () => retained,
    publishRetained(value) { retained = value; },
    withSerialization: operation => operation(),
    authorizePublication: (_kind, evidence) => {
      authorizedEvidenceKeys.push(Object.keys(evidence).sort());
      return authorized;
    },
  });
  assert.deepEqual(store.read(), { version: 1, revision: 0 });
  const identity = { profileKey: "profile:work", recoveryKey: "journal:work" };
  assert.equal(store.publish({ expectedRevision: 0, kind: "writer-exclusion",
    evidence: { version: 1, status: "excluded", ...identity } }).revision, 1);
  assert.equal(store.publish({ expectedRevision: 1, kind: "migration",
    evidence: { version: 1, status: "complete", ...identity } }).revision, 2);
  const startupExclusion = { version: 1 as const, status: "enforced" as const,
    authorityId: "operator-cutover:1", closureOperationId: "closure:1", ...identity,
    writerInventorySha256: "a".repeat(64), allowedWriterProtocol: "custody-v3" as const,
    authorizedAtMs: 1_000 };
  assert.equal(store.publish({ expectedRevision: 2, kind: "startup-exclusion",
    evidence: startupExclusion }).revision, 3);
  assert.deepEqual(store.read(), { version: 1, revision: 3,
    writerExclusion: { version: 1, status: "excluded", ...identity },
    migration: { version: 1, status: "complete", ...identity }, startupExclusion });
  assert.throws(() => store.publish({ expectedRevision: 1, kind: "migration",
    evidence: { version: 1, status: "complete", ...identity } }), /revision changed/);
  const beforeInvalidKind = retained;
  const callbacksBeforeInvalidKind = authorizedEvidenceKeys.length;
  assert.throws(() => store.publish({ expectedRevision: 3, kind: "migration",
    evidence: { version: 1, status: "excluded", ...identity } as unknown as
      { version: 1; status: "complete"; profileKey: string; recoveryKey: string } }), /malformed/);
  assert.equal(retained, beforeInvalidKind);
  assert.equal(authorizedEvidenceKeys.length, callbacksBeforeInvalidKind);
  assert.throws(() => store.publish({ expectedRevision: 3, kind: "migration",
    evidence: { version: 1, status: "complete", profileKey: "profile:other",
      recoveryKey: "journal:other" } }), /conflicting identities/);
  assert.equal(retained, beforeInvalidKind);
  assert.equal(authorizedEvidenceKeys.length, callbacksBeforeInvalidKind);
  authorized = false;
  assert.throws(() => store.publish({ expectedRevision: 3, kind: "startup-exclusion",
    evidence: { ...startupExclusion, status: "revoked" } }), /unauthorized/);
  authorized = true;
  assert.equal(store.publish({ expectedRevision: 3, kind: "startup-exclusion",
    evidence: { ...startupExclusion, status: "revoked" } }).revision, 4);
  assert.equal(store.read().startupExclusion?.status, "revoked");
  const beforeAuthorityConflict = retained;
  assert.throws(() => store.publish({ expectedRevision: 4, kind: "writer-exclusion",
    evidence: { version: 1, status: "excluded", ...identity, startupAuthorityId: "other",
      closureOperationId: startupExclusion.closureOperationId,
      writerInventorySha256: startupExclusion.writerInventorySha256 } }), /conflicting authorities/);
  assert.equal(retained, beforeAuthorityConflict);
  const migrationCompletion = { version: 1 as const, status: "authorized" as const,
    authorityId: "migration:1", startupAuthorityId: startupExclusion.authorityId,
    closureOperationId: startupExclusion.closureOperationId, ...identity,
    migrationInventorySha256: "b".repeat(64), resultingSourceFamily: "v3" as const,
    authorizedAtMs: 1_100 };
  assert.equal(store.publish({ expectedRevision: 4, kind: "migration-completion",
    evidence: migrationCompletion }).revision, 5);
  assert.equal(store.publish({ expectedRevision: 5, kind: "migration", evidence: {
    version: 1, status: "complete", ...identity,
    migrationAuthorityId: migrationCompletion.authorityId,
    startupAuthorityId: migrationCompletion.startupAuthorityId,
    closureOperationId: migrationCompletion.closureOperationId,
    migrationInventorySha256: migrationCompletion.migrationInventorySha256,
    resultingSourceFamily: migrationCompletion.resultingSourceFamily } }).revision, 6);
  assert.equal(store.read().migrationCompletion?.authorityId, "migration:1");
  retained = "{broken";
  assert.throws(() => store.read(), /malformed/);
});

test("V3 writer cutover installs mode before linked exclusion publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-writer-cutover-"));
  try {
    const expected = { profileKey: "profile:work", recoveryKey: "journal:work" };
    const digest = "a".repeat(64);
    const owner = { processId: 101, processBirthId: "101:start:cutover" };
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"),
      profileKey: expected.profileKey, owner, getNowMs: () => 1_000,
      getProcessLiveness: () => "alive" });
    const closure = ledger.acquireJournalWriterClosure({ operationId: "closure:cutover",
      recoveryKey: expected.recoveryKey, requestedAtMs: 900 });
    assert.equal(closure.kind, "acquired");
    if (closure.kind !== "acquired") return;
    let retained: string | undefined;
    const store = createTelegramInputCustodyReadinessEvidenceStore({
      readRetained: () => retained, publishRetained(value) { retained = value; },
      withSerialization: operation => operation(), authorizePublication: () => true });
    const authority = { version: 1 as const, status: "enforced" as const,
      authorityId: "operator-cutover:1", closureOperationId: closure.fence.operationId,
      ...expected, writerInventorySha256: digest, allowedWriterProtocol: "custody-v3" as const,
      authorizedAtMs: 950 };
    store.publish({ expectedRevision: 0, kind: "startup-exclusion", evidence: authority });
    const run = () => executeTelegramInputCustodyWriterCutover({ expected,
      closure: closure.fence, startupAuthority: authority,
      inventory: { ...expected, complete: true, writerInventorySha256: digest, writers: [] },
      getProcessLiveness: () => "dead",
      installProtocolMode: (fence, evidence) => ledger.installJournalWriterProtocolMode(fence, evidence),
      evidenceStore: store });
    const completed = run();
    assert.equal(completed.kind, "completed");
    assert.equal(ledger.read().fence, undefined);
    assert.equal(ledger.read().writerProtocolMode?.startupAuthorityId, authority.authorityId);
    assert.equal(store.read().writerExclusion?.closureOperationId, closure.fence.operationId);
    const resumed = run();
    assert.equal(resumed.kind, "completed");
    if (resumed.kind === "completed") assert.equal(resumed.resumed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("V3 writer cutover keeps mode non-ready when authority changes after installation", () => {
  const expected = { profileKey: "profile:work", recoveryKey: "journal:work" };
  const digest = "a".repeat(64);
  const authority = { version: 1 as const, status: "enforced" as const,
    authorityId: "operator-cutover:1", closureOperationId: "closure:1", ...expected,
    writerInventorySha256: digest, allowedWriterProtocol: "custody-v3" as const,
    authorizedAtMs: 1_000 };
  let reads = 0;
  let publications = 0;
  const result = executeTelegramInputCustodyWriterCutover({ expected,
    closure: { operationId: "closure:1", ...expected }, startupAuthority: authority,
    inventory: { ...expected, complete: true, writerInventorySha256: digest, writers: [] },
    getProcessLiveness: () => "dead",
    installProtocolMode: () => ({ resumed: false, mode: { protocol: "custody-v3", ...expected,
      startupAuthorityId: authority.authorityId, closureOperationId: authority.closureOperationId,
      writerInventorySha256: digest } }),
    evidenceStore: {
      read: () => ({ version: 1, revision: reads++, startupExclusion:
        reads === 1 ? authority : { ...authority, status: "revoked" } }),
      publish: () => { publications += 1; throw new Error("must not publish"); },
    },
  });
  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") assert.equal(result.blocker, "startup-authority");
  assert.equal(publications, 0);
});

test("V3 proven readiness requires linked startup authority and installed protocol mode", () => {
  const expected = { profileKey: "profile:work", recoveryKey: "journal:work" };
  const digest = "a".repeat(64);
  let writerEvidence: { version: 1; status: "excluded"; profileKey: string; recoveryKey: string;
    startupAuthorityId?: string; closureOperationId?: string; writerInventorySha256?: string } =
    { version: 1, status: "excluded", ...expected };
  let startupAuthority = { version: 1 as const, status: "enforced" as "enforced" | "revoked",
    authorityId: "operator-cutover:1", closureOperationId: "closure:1", ...expected,
    writerInventorySha256: digest, allowedWriterProtocol: "custody-v3" as const,
    authorizedAtMs: 1_000 };
  let migrationEvidence: { version: 1; status: "complete"; profileKey: string; recoveryKey: string;
    migrationAuthorityId?: string; startupAuthorityId?: string; closureOperationId?: string;
    migrationInventorySha256?: string; resultingSourceFamily?: "absent" | "v3" } =
    { version: 1, status: "complete", ...expected };
  const migrationDigest = "b".repeat(64);
  let migrationAuthority = { version: 1 as const, status: "authorized" as "authorized" | "revoked",
    authorityId: "migration:1", startupAuthorityId: startupAuthority.authorityId,
    closureOperationId: startupAuthority.closureOperationId, ...expected,
    migrationInventorySha256: migrationDigest, resultingSourceFamily: "v3" as const,
    authorizedAtMs: 1_100 };
  let writerProtocolMode: { protocol: "custody-v3"; profileKey: string; recoveryKey: string;
    startupAuthorityId: string; closureOperationId: string; writerInventorySha256: string } | undefined;
  let sourceStatus: "absent" | "v3" = "v3";
  const resolve = createTelegramInputCustodyProvenReadinessResolver({
    isRequested: () => true, expectedIdentity: () => expected,
    inspectSource: () => sourceStatus, listPeerReadiness: () => ["ready"],
    readWriterExclusionEvidence: () => writerEvidence,
    readStartupExclusionAuthority: () => startupAuthority,
    readWriterProtocolMode: () => writerProtocolMode,
    readMigrationCompletionAuthority: () => migrationAuthority,
    readMigrationEvidence: () => migrationEvidence,
  });
  assert.deepEqual(resolve(), { enabled: false, blocker: "legacy-writers-present" });
  writerEvidence = { ...writerEvidence, startupAuthorityId: startupAuthority.authorityId,
    closureOperationId: startupAuthority.closureOperationId, writerInventorySha256: digest };
  assert.deepEqual(resolve(), { enabled: false, blocker: "legacy-writers-present" });
  writerProtocolMode = { protocol: "custody-v3", ...expected,
    startupAuthorityId: startupAuthority.authorityId,
    closureOperationId: startupAuthority.closureOperationId, writerInventorySha256: digest };
  assert.deepEqual(resolve(), { enabled: false, blocker: "migration-incomplete" });
  migrationEvidence = { ...migrationEvidence, migrationAuthorityId: migrationAuthority.authorityId,
    startupAuthorityId: migrationAuthority.startupAuthorityId,
    closureOperationId: migrationAuthority.closureOperationId,
    migrationInventorySha256: migrationDigest, resultingSourceFamily: "v3" };
  assert.deepEqual(resolve(), { enabled: true });
  startupAuthority = { ...startupAuthority, status: "revoked" };
  assert.deepEqual(resolve(), { enabled: false, blocker: "legacy-writers-present" });
  startupAuthority = { ...startupAuthority, status: "enforced" };
  writerProtocolMode = { ...writerProtocolMode, closureOperationId: "closure:other" };
  assert.deepEqual(resolve(), { enabled: false, blocker: "legacy-writers-present" });
  writerProtocolMode = { ...writerProtocolMode,
    closureOperationId: startupAuthority.closureOperationId };
  writerEvidence = { ...writerEvidence, writerInventorySha256: "b".repeat(64) };
  assert.deepEqual(resolve(), { enabled: false, blocker: "legacy-writers-present" });
  writerEvidence = { ...writerEvidence, writerInventorySha256: digest };
  migrationEvidence = { ...migrationEvidence, profileKey: "profile:other" };
  assert.deepEqual(resolve(), { enabled: false, blocker: "migration-incomplete" });
  migrationEvidence = { ...migrationEvidence, profileKey: expected.profileKey };
  sourceStatus = "absent";
  assert.deepEqual(resolve(), { enabled: false, blocker: "migration-incomplete" });
  sourceStatus = "v3";
  migrationAuthority = { ...migrationAuthority, status: "revoked" };
  assert.deepEqual(resolve(), { enabled: false, blocker: "migration-incomplete" });
});

test("V3 activation readiness resolver is lazy and fails closed on inspection loss", () => {
  let requested = false;
  let sourceReads = 0;
  let peerReads = 0;
  let writersExcluded = true;
  let migrationComplete = true;
  let sourceThrows = false;
  let peersThrow = false;
  const resolve = createTelegramInputCustodyActivationReadinessResolver({
    isRequested: () => requested,
    inspectSource() { sourceReads += 1; if (sourceThrows) throw new Error("lost source proof"); return "v3"; },
    areLegacyWritersExcluded: () => writersExcluded,
    isHistoricalMigrationComplete: () => migrationComplete,
    listPeerReadiness() { peerReads += 1; if (peersThrow) throw new Error("lost peer proof"); return ["ready"]; },
  });
  assert.deepEqual(resolve(), { enabled: false, blocker: "disabled" });
  assert.deepEqual([sourceReads, peerReads], [0, 0]);
  requested = true;
  writersExcluded = false;
  assert.deepEqual(resolve(), { enabled: false, blocker: "legacy-writers-present" });
  assert.deepEqual([sourceReads, peerReads], [0, 0]);
  writersExcluded = true;
  migrationComplete = false;
  assert.deepEqual(resolve(), { enabled: false, blocker: "migration-incomplete" });
  assert.deepEqual([sourceReads, peerReads], [0, 0]);
  migrationComplete = true;
  sourceThrows = true;
  assert.deepEqual(resolve(), { enabled: false, blocker: "source-unready" });
  assert.deepEqual([sourceReads, peerReads], [1, 0]);
  sourceThrows = false;
  peersThrow = true;
  assert.deepEqual(resolve(), { enabled: false, blocker: "peer-capability-mismatch" });
  peersThrow = false;
  assert.deepEqual(resolve(), { enabled: true });
});

test("Legacy custody operator runtime resolves exact live binding without caching", () => {
  const calls: string[] = [];
  let bindingKey = "journal:g1";
  const candidate = { updateId: 7, state: "retry-wait" as const, attemptCount: 2,
    failureClass: "transport", evidenceSha256: "a".repeat(64) };
  const runtime = createTelegramInputCustodyLegacyDispositionRuntime({
    withBindingReference(recoveryKey, operation) {
      if (recoveryKey !== bindingKey) throw new Error("binding is unavailable");
      calls.push(`enter:${bindingKey}`);
      try {
        return operation({ recoveryKey: bindingKey, journal: {
          listLegacyCustodyCandidates() { calls.push(`list:${bindingKey}`); return [candidate]; },
          applyLegacyCustodyDisposition(authority) {
            calls.push(`apply:${bindingKey}:${authority.dispositionId}`);
            return { disposition: { dispositionKind: "legacy-custody" as const,
              failureId: authority.dispositionId, updateId: authority.updateId,
              action: authority.action, committedAtMs: authority.authorizedAtMs,
              evidenceSha256: authority.evidenceSha256,
              operatorAuthorityId: authority.operatorAuthorityId,
              authorizedAtMs: authority.authorizedAtMs }, duplicate: false,
              entryCount: 1, serializedBytes: 1 };
          } } });
      } finally { calls.push(`exit:${bindingKey}`); }
    },
  });
  assert.deepEqual(runtime.list("journal:g1"), [candidate]);
  bindingKey = "journal:g2";
  assert.throws(() => runtime.list("journal:g1"), /binding is unavailable/);
  const authority = { version: 1 as const, dispositionId: "legacy:7", updateId: 7,
    evidenceSha256: candidate.evidenceSha256, action: "discard" as const,
    operatorAuthorityId: "operator:1", authorizedAtMs: 500 };
  assert.equal(runtime.apply("journal:g2", authority).disposition.failureId, "legacy:7");
  assert.deepEqual(calls, ["enter:journal:g1", "list:journal:g1", "exit:journal:g1",
    "enter:journal:g2", "apply:journal:g2:legacy:7", "exit:journal:g2"]);
});

test("V3 worker journal port exposes custody and refuses every legacy raw mutation", async context => {
  await withInputCustodyFixture(context, async ({ options, path }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 1 }], 1);
    const port = createTelegramInputCustodyWorkerJournalPort(store);
    assert.deepEqual(Object.keys(port.inputCustody).sort(),
      ["acquireInput", "completeInput", "queueInputs", "startInput"]);
    assert.equal("applyLegacyCustodyDisposition" in port.inputCustody, false);
    assert.equal("listLegacyCustodyCandidates" in port.inputCustody, false);
    assert.equal(port.read().version, 3);
    const before = await readFile(path, "utf8");
    assert.throws(() => port.removeCompleted([1]), /forbids legacy raw worker settlement/);
    assert.throws(() => port.markQueued({ queueKind: "prompt", receiptId: "legacy",
      sourceUpdateIds: [1], owner: { ...options.queueRuntimeIdentity, sessionGeneration: 1 } }),
    /forbids legacy raw worker settlement/);
    assert.throws(() => port.markExecutionFailure({ updateId: 1, expectedAttemptCount: 0,
      failedAtMs: 1, failureClass: "legacy", summary: "legacy", disposition: "failed" }),
    /forbids legacy raw worker settlement/);
    assert.equal(await readFile(path, "utf8"), before);
    let enabled = false;
    let sourceReads = 0;
    let recipientReads = 0;
    const resolve = createTelegramInputCustodyLifecycleBindingResolver({
      isEnabled: () => enabled,
      resolveInputJournal() { sourceReads += 1; return { runtimeKey: "runtime-v3",
        recoveryKey: createTelegramUpdateJournalBindingKey(options), journal: store }; },
      getRecipientBindingKey() { recipientReads += 1; return "workspace:owner"; },
    });
    assert.equal(resolve(), undefined);
    assert.deepEqual([sourceReads, recipientReads], [0, 0]);
    enabled = true;
    const binding = resolve();
    assert.equal(binding?.runtimeKey,
      JSON.stringify({ source: "runtime-v3", recipientBindingKey: "workspace:owner" }));
    assert.equal(binding?.recipientBindingKey, "workspace:owner");
    assert.equal(binding?.journal.read().version, 3);
    assert.deepEqual([sourceReads, recipientReads], [1, 1]);
    const raw = store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    assert.equal(store.startInput(raw.receipt).started, true);
    const queued = store.queueInputs({ queueKind: "prompt", receiptId: "v3-handoff",
      receipts: [raw.receipt] }).queueReceipt;
    const recipientOwner = { instanceId: "recipient", processId: process.pid + 1,
      processBirthId: `${process.pid + 1}:recipient`, sessionGeneration: 1 };
    const handoff = { queueKind: queued.queueKind, receiptId: queued.receiptId,
      sourceUpdateIds: queued.sourceUpdateIds, expectedOwner: queued.queueOwner, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() };
    assert.deepEqual(binding?.journal.offerQueuedHandoff?.(handoff).offeredUpdateIds, [1]);
    assert.deepEqual(binding?.journal.cancelQueuedHandoff?.(handoff).cancelledUpdateIds, [1]);
  });
});

test("Custodied execution adapter starts once and settles complete or single-input queue outcomes", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }], 3);
    assert.deepEqual(await executeTelegramCustodiedInput({ journal: store,
      update: { update_id: 1 }, recipientBindingKey: "workspace:owner",
      async execute() { return { kind: "complete" }; } }), { status: "completed" });
    let ambiguousExecutions = 0;
    await assert.rejects(executeTelegramCustodiedInput({ journal: store,
      update: { update_id: 2 }, recipientBindingKey: "workspace:owner",
      async execute() { ambiguousExecutions += 1; throw new Error("execution outcome unknown"); } }));
    assert.equal((await executeTelegramCustodiedInput({ journal: store,
      update: { update_id: 2 }, recipientBindingKey: "workspace:owner",
      async execute() { ambiguousExecutions += 1; return { kind: "complete" }; } })).status,
    "outcome-unknown");
    assert.equal(ambiguousExecutions, 1);
    const queued = await executeTelegramCustodiedInput({ journal: store,
      update: { update_id: 3 }, recipientBindingKey: "workspace:owner",
      async execute() { return { kind: "queued", queueKind: "prompt",
        receiptId: "queue-three", sourceUpdateIds: [3] }; } });
    assert.equal(queued.status, "queued");
    if (queued.status === "queued") assert.equal(queued.queueReceipt.receiptId, "queue-three");
    assert.deepEqual(store.read().entries.map(entry => [entry.updateId, entry.state]),
      [[2, "pending"], [3, "queued"]]);
  });
});

test("Custodied execution session groups deferred and current receipts atomically", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 10 }, { update_id: 11 }, { update_id: 12 },
      { update_id: 13 }], 13);
    const session = createTelegramCustodiedExecutionSession({ journal: store,
      recipientBindingKey: "workspace:owner" });
    const deferred = await session.execute({ update_id: 10 },
      async () => ({ kind: "deferred" }));
    assert.equal(deferred.status, "deferred");
    assert.equal((await session.execute({ update_id: 11 },
      async () => ({ kind: "deferred" }))).status, "deferred");
    const queued = await session.settle(11, { kind: "queued",
      queueKind: "prompt", receiptId: "grouped-receipt", sourceUpdateIds: [10, 11] });
    assert.equal(queued.status, "queued");
    assert.equal((await session.settle(10, { kind: "queued", queueKind: "prompt",
      receiptId: "grouped-receipt", sourceUpdateIds: [10, 11] })).status, "queued");
    await assert.rejects(session.settle(10, { kind: "queued", queueKind: "prompt",
      receiptId: "conflict", sourceUpdateIds: [10, 11] }), /no exact running receipt/);
    assert.deepEqual(store.read().entries.map(entry => [entry.updateId, entry.state,
      entry.queueReceiptId]), [[10, "queued", "grouped-receipt"],
      [11, "queued", "grouped-receipt"], [12, "pending", undefined],
      [13, "pending", undefined]]);
    assert.equal((await session.execute({ update_id: 12 },
      async () => ({ kind: "deferred" }))).status, "deferred");
    assert.deepEqual(await session.settle(12, { kind: "complete" }), { status: "completed" });
    await assert.rejects(session.settle(12, { kind: "complete" }), /no exact running receipt/);
    await assert.rejects(session.execute({ update_id: 13 }, async () => {
      throw new Error("ambiguous running execution");
    }));
    await assert.rejects(session.settle(13, { kind: "complete" }), /no exact running receipt/);
    const replacement = createTelegramCustodiedExecutionSession({ journal: store,
      recipientBindingKey: "workspace:owner" });
    assert.equal((await replacement.execute({ update_id: 13 },
      async () => ({ kind: "complete" }))).status, "outcome-unknown");
    await assert.rejects(replacement.settle(13, { kind: "complete" }), /no exact running receipt/);
    if (deferred.status === "deferred")
      assert.throws(() => store.completeInput(deferred.receipt),
        error => isJournalError(error, "conflict"));
  });
});

test("Custodied admission handle settles a late report through its retained receipt", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 20, message: { chat: { type: "private" } } }], 20);
    let deferredMessage: { chat: { type: string } } | undefined;
    const lateErrors: unknown[] = [];
    const lateSettlements: string[] = [];
    const handle = createTelegramCustodiedUpdateAdmissionHandle({ journal: store,
      recipientBindingKey: "workspace:owner",
      async defaultHandle(update) {
        deferredMessage = update.message;
        assert.equal(reportTelegramUpdateDeferred(update.message), true);
      },
      onLateOutcomeError(error) { lateErrors.push(error); },
      onCustodiedLateSettlement(result) { lateSettlements.push(result.status); },
    });
    const result = await handle({ update_id: 20, message: { chat: { type: "private" } } }, {},
      new AbortController().signal);
    assert.equal(result.status, "deferred");
    assert.ok(deferredMessage);
    assert.equal(reportTelegramUpdateCompleted(deferredMessage), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lateErrors, []);
    assert.deepEqual(lateSettlements, ["completed"]);
    assert.deepEqual(store.read().entries, []);
  });
});

test("Assembled custodied worker publishes one late grouped queue receipt", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 30, message: { chat: { type: "private" } } },
      { update_id: 31, message: { chat: { type: "private" } } }], 31);
    const port = createTelegramInputCustodyWorkerJournalPort(store);
    const owner = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    const sources: unknown[] = [];
    const published: string[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime({ journal: port,
      inputCustody: port.inputCustody,
      getJournalBindingKey: () => createTelegramUpdateJournalBindingKey(options),
      getRecipientBindingKey: () => "workspace:owner",
      getQueueOwnerIdentity: () => owner, hasAuthority: () => true,
      async defaultHandle(update) {
        sources.push(update.message);
        if (sources.length === 1) {
          assert.equal(reportTelegramUpdateDeferred(update.message), true);
          return;
        }
        assert.equal(reportTelegramQueueAdmission(sources, [{ queueKind: "prompt",
          receiptId: "late-group", sourceUpdateIds: [30, 31],
          journalBindingKey: createTelegramUpdateJournalBindingKey(options) }]), true);
      },
      onQueueReceiptCommitted(receipt) { published.push(receipt.receiptId); },
    });
    try {
      worker.start({});
      await worker.waitForDrain();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(published, ["late-group"]);
      assert.deepEqual(store.read().entries.map(entry => [entry.updateId, entry.state,
        entry.queueReceiptId]), [[30, "queued", "late-group"], [31, "queued", "late-group"]]);
      assert.equal(worker.getState().queuedClaimCount, 2);
      assert.equal(worker.getState().blockedReason, undefined);
    } finally { await worker.stop(); }
  });
});

test("V3 lifecycle replacement never replays retained running input", async context => {
  await withInputCustodyFixture(context, async ({ options, setBinding }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 40 }], 40);
    const acquired = store.acquireInput({ updateId: 40,
      recipientBindingKey: "workspace:owner", executionUpdate: { update_id: 40 } });
    assert.equal(store.startInput(acquired.receipt).started, true);
    let recipientBindingKey = "workspace:owner";
    const resolve = createTelegramInputCustodyLifecycleBindingResolver({
      isEnabled: () => true,
      resolveInputJournal: () => ({ runtimeKey: "runtime-v3",
        recoveryKey: createTelegramUpdateJournalBindingKey(options), journal: store }),
      getRecipientBindingKey: () => recipientBindingKey,
    });
    const owner = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    let handlerCalls = 0;
    const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime({ resolveBinding: resolve,
      getQueueOwnerIdentity: () => owner,
      createWorker(journal, binding) {
        return createTelegramUpdateAdmissionWorkerRuntime({ journal,
          inputCustody: binding.journal.inputCustody,
          getJournalBindingKey: () => binding.recoveryKey,
          getRecipientBindingKey: () => binding.recipientBindingKey,
          getQueueOwnerIdentity: () => owner, hasAuthority: () => true,
          async defaultHandle() { handlerCalls += 1; } });
      },
    });
    try {
      await lifecycle.onSessionStart({});
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      assert.equal(handlerCalls, 0);
      recipientBindingKey = "workspace:replacement";
      setBinding(recipientBindingKey);
      await lifecycle.onTransportChanged({});
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      assert.equal(handlerCalls, 0);
      assert.equal(store.read().entries[0]?.inputClaim?.phase, "running");
    } finally { await lifecycle.onSessionShutdown(); }
  });
});

test("Leader-follower custody assembly never replays running input across generation and role", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 50 }], 50);
    const acquired = store.acquireInput({ updateId: 50,
      recipientBindingKey: "workspace:owner", executionUpdate: { update_id: 50 } });
    assert.equal(store.startInput(acquired.receipt).started, true);
    const resolve = createTelegramInputCustodyLifecycleBindingResolver({
      isEnabled: () => true,
      resolveInputJournal: () => ({ runtimeKey: "role-v3",
        recoveryKey: createTelegramUpdateJournalBindingKey(options), journal: store }),
      getRecipientBindingKey: () => "workspace:owner",
    });
    const owner = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    let registered = true;
    let generation = "g1";
    let leader = false;
    let handlerCalls = 0;
    const assembly = createTelegramUpdateAdmissionLifecycleAssembly({
      runtimeBinding: createTelegramUpdateAdmissionRuntimeBinding({
        isFollowerRegistered: () => registered }),
      worker: { getQueueOwnerIdentity: () => owner,
        async defaultHandle() { handlerCalls += 1; } },
      leader: { resolveBinding: resolve, hasAuthority: () => leader },
      follower: { resolveBinding: resolve, isRegistered: () => registered,
        getGeneration: () => generation, prepareUpdateForExecution: update => update },
    });
    try {
      await assembly.follower.onSessionStart({});
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      generation = "g2";
      await assembly.follower.onTransportChanged({});
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      registered = false;
      await assembly.follower.onTransportChanged({});
      leader = true;
      await assembly.leader.onSessionStart({});
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      assert.equal(handlerCalls, 0);
      assert.equal(store.read().entries[0]?.inputClaim?.phase, "running");
    } finally {
      await assembly.follower.onSessionShutdown();
      await assembly.leader.onSessionShutdown();
    }
  });
});

test("V3 worker drains independent tail behind retained running input", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 60 }, { update_id: 61 }, { update_id: 62 },
      { update_id: 63 }, { update_id: 64 }, { update_id: 65 }], 65);
    const running = store.acquireInput({ updateId: 60,
      recipientBindingKey: "workspace:owner", executionUpdate: { update_id: 60 } });
    assert.equal(store.startInput(running.receipt).started, true);
    const port = createTelegramInputCustodyWorkerJournalPort(store);
    const owner = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    const executed: number[] = [];
    let yields = 0;
    const worker = createTelegramUpdateAdmissionWorkerRuntime({ journal: port,
      inputCustody: port.inputCustody,
      getJournalBindingKey: () => createTelegramUpdateJournalBindingKey(options),
      getRecipientBindingKey: () => "workspace:owner",
      getQueueOwnerIdentity: () => owner, hasAuthority: () => true, batchSize: 2,
      async yieldToEventLoop() { yields += 1; },
      async defaultHandle(update) { executed.push(update.update_id); },
    });
    try {
      worker.start({});
      await worker.waitForDrain();
      assert.deepEqual(executed, [61, 62, 63, 64, 65]);
      assert.equal(yields, 5);
      assert.deepEqual(store.read().entries.map(entry => entry.updateId), [60]);
      assert.equal(store.read().entries[0]?.inputClaim?.phase, "running");
      assert.equal(worker.getState().blockedReason, "execution");
      assert.deepEqual(worker.getState().blockedInputCustody,
        { updateId: 60, kind: "running-outcome-unknown" });
      const diagnostic = JSON.stringify(worker.getState());
      assert.doesNotMatch(diagnostic, /workspace:owner|fixture-birth|acquisitionId/);
    } finally { await worker.stop(); }
  });
});

test("V3 worker drains tail behind frozen ready handoff custody", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 70 }, { update_id: 71 }], 71);
    const ready = store.acquireInput({ updateId: 70, recipientBindingKey: "workspace:owner" });
    const recipientOwner = { instanceId: "recipient", processId: process.pid + 1,
      processBirthId: `${process.pid + 1}:recipient`, sessionGeneration: 1 };
    const offered = store.offerInputHandoff({ receipt: ready.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    const port = createTelegramInputCustodyWorkerJournalPort(store);
    const owner = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    const executed: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime({ journal: port,
      inputCustody: port.inputCustody,
      getJournalBindingKey: () => createTelegramUpdateJournalBindingKey(options),
      getRecipientBindingKey: () => "workspace:owner", getQueueOwnerIdentity: () => owner,
      hasAuthority: () => true, async defaultHandle(update) { executed.push(update.update_id); } });
    try {
      worker.start({});
      await worker.waitForDrain();
      assert.deepEqual(executed, [71]);
      assert.deepEqual(store.read().entries.map(entry => entry.updateId), [70]);
      assert.equal(store.read().entries[0]?.inputClaim?.phase, "ready");
      assert.ok(store.read().entries[0]?.inputClaim?.handoff);
      assert.equal(worker.getState().blockedReason, "input-custody");
      assert.deepEqual(worker.getState().blockedInputCustody,
        { updateId: 70, kind: "handoff-frozen" });
      store.cancelInputHandoff({ receipt: ready.receipt, recipientOwner,
        handoffId: offered.handoff.handoffId });
      worker.signal();
      await worker.waitForDrain();
      assert.deepEqual(executed, [71, 70]);
      assert.deepEqual(store.read().entries, []);
      assert.equal(worker.getState().blockedInputCustody, undefined);
    } finally { await worker.stop(); }
  });
});

test("V3 worker drains tail behind foreign ready custody", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const donor = createTelegramInputJournalStore(options);
    donor.appendBatch([{ update_id: 80 }, { update_id: 81 }], 81);
    donor.acquireInput({ updateId: 80, recipientBindingKey: "workspace:owner" });
    const runtime = { instanceId: "replacement", processId: process.pid + 2,
      processBirthId: `${process.pid + 2}:replacement` };
    const owner = { ...runtime, sessionGeneration: 1 };
    const recipient = createTelegramInputJournalStore({ ...options,
      queueRuntimeIdentity: runtime,
      getInputContext: () => ({ owner, recipientBindingKey: "workspace:owner" }) });
    const port = createTelegramInputCustodyWorkerJournalPort(recipient);
    const executed: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime({ journal: port,
      inputCustody: port.inputCustody,
      getJournalBindingKey: () => createTelegramUpdateJournalBindingKey(options),
      getRecipientBindingKey: () => "workspace:owner", getQueueOwnerIdentity: () => owner,
      hasAuthority: () => true, async defaultHandle(update) { executed.push(update.update_id); } });
    try {
      worker.start({});
      await worker.waitForDrain();
      assert.deepEqual(executed, [81]);
      assert.deepEqual(recipient.read().entries.map(entry => entry.updateId), [80]);
      assert.equal(recipient.read().entries[0]?.inputClaim?.phase, "ready");
      assert.equal(worker.getState().blockedReason, "input-custody");
      assert.deepEqual(worker.getState().blockedInputCustody,
        { updateId: 80, kind: "foreign-ready" });
    } finally { await worker.stop(); }
  });
});

test("V3 blocked diagnostics prioritize running outcome unknown over foreign ready", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const donor = createTelegramInputJournalStore(options);
    donor.appendBatch([{ update_id: 90 }, { update_id: 91 }], 91);
    donor.acquireInput({ updateId: 90, recipientBindingKey: "workspace:owner" });
    const running = donor.acquireInput({ updateId: 91,
      recipientBindingKey: "workspace:owner", executionUpdate: { update_id: 91 } });
    assert.equal(donor.startInput(running.receipt).started, true);
    const runtime = { instanceId: "observer", processId: process.pid + 3,
      processBirthId: `${process.pid + 3}:observer` };
    const owner = { ...runtime, sessionGeneration: 1 };
    const observer = createTelegramInputJournalStore({ ...options,
      queueRuntimeIdentity: runtime,
      getInputContext: () => ({ owner, recipientBindingKey: "workspace:owner" }) });
    const port = createTelegramInputCustodyWorkerJournalPort(observer);
    const worker = createTelegramUpdateAdmissionWorkerRuntime({ journal: port,
      inputCustody: port.inputCustody,
      getJournalBindingKey: () => createTelegramUpdateJournalBindingKey(options),
      getRecipientBindingKey: () => "workspace:owner", getQueueOwnerIdentity: () => owner,
      hasAuthority: () => true, async defaultHandle() { assert.fail("blocked input executed"); } });
    try {
      worker.start({});
      await worker.waitForDrain();
      assert.equal(worker.getState().blockedReason, "execution");
      assert.deepEqual(worker.getState().blockedInputCustody,
        { updateId: 91, kind: "running-outcome-unknown" });
    } finally { await worker.stop(); }
  });
});

test("V3 worker quarantines legacy retry state while draining pending tail", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 100 }, { update_id: 101 }], 101);
    const strict = createTelegramInputCustodyWorkerJournalPort(store);
    const journal = { ...strict, read() {
      const snapshot = strict.read();
      return { ...snapshot, entries: snapshot.entries.map(entry => entry.updateId === 100
        ? { ...entry, state: "retry-wait" as const, nextRetryAtMs: 0 } : entry) };
    } };
    const owner = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    const executed: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime({ journal,
      inputCustody: strict.inputCustody,
      getJournalBindingKey: () => createTelegramUpdateJournalBindingKey(options),
      getRecipientBindingKey: () => "workspace:owner", getQueueOwnerIdentity: () => owner,
      hasAuthority: () => true, async defaultHandle(update) { executed.push(update.update_id); } });
    try {
      worker.start({});
      await worker.waitForDrain();
      assert.deepEqual(executed, [101]);
      assert.deepEqual(store.read().entries.map(entry => entry.updateId), [100]);
      assert.equal(worker.getState().blockedReason, "input-custody");
      assert.deepEqual(worker.getState().blockedInputCustody,
        { updateId: 100, kind: "legacy-retry-state" });
    } finally { await worker.stop(); }
  });
});

test("V3 source-reference wake requires one exact accepted ready handoff", async context => {
  await withInputCustodyFixture(context, async ({ options, dir }) => {
    const donor = createTelegramInputJournalStore(options);
    donor.appendBatch([{ update_id: 109 }], 109);
    const claimed = donor.acquireInput({ updateId: 109, recipientBindingKey: "workspace:owner" });
    const recipientRuntime = { instanceId: "recipient", processId: process.pid + 4,
      processBirthId: `${process.pid + 4}:recipient` };
    const recipientOwner = { ...recipientRuntime, sessionGeneration: 1 };
    const offered = donor.offerInputHandoff({ receipt: claimed.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    const recipient = createTelegramInputJournalStore({ ...options,
      queueRuntimeIdentity: recipientRuntime,
      getInputContext: () => ({ owner: recipientOwner, recipientBindingKey: "workspace:owner" }) });
    const recoveryKey = createTelegramUpdateJournalBindingKey(options);
    const frozenResolver = createTelegramInputCustodyForwardReferenceResolver({
      recoveryKey, recipientBindingKey: "workspace:owner", recipientOwner, journal: recipient });
    assert.equal(frozenResolver({ sourceUpdateId: 109,
      recipientBindingKey: "workspace:owner" }), undefined);
    let wakes = 0;
    const acceptance = createTelegramInputCustodyHandoffAcceptanceRuntime({
      resolveBinding: key => key === recoveryKey ? { recoveryKey,
        recipientBindingKey: "workspace:owner", recipientOwner, journal: recipient,
        signalWorker() { wakes += 1; } } : undefined,
    });
    const accepted = acceptance.accept({ sourceRecoveryKey: recoveryKey,
      recipientBindingKey: "workspace:owner", source: offered.source,
      handoffId: offered.handoff.handoffId }, {});
    assert.equal(accepted.duplicate, false);
    assert.equal(wakes, 1);
    const handoffSocketPath = join(dir, "input-handoff.sock");
    const handoffReceiver = createTelegramBusForwardedUpdateReceiverRuntime({
      socketPath: handoffSocketPath, instanceId: "recipient",
      getAuthSecret: () => "shared-secret", getRegistrationGeneration: () => "g2",
      getRecipientBindingKey: () => "workspace:owner",
      durableAdmission: { async admit() { assert.fail("legacy copy admission invoked"); } },
      isSourceReferenceAdmissionEnabled: () => true,
      hasAuthenticatedSourceReferenceTransport: () => true, getContext: () => ({}),
      handleInputCustodyHandoff: (envelope, ctx) => acceptance.accept({
        sourceRecoveryKey: envelope.sourceRecoveryKey,
        recipientBindingKey: envelope.recipientBindingKey,
        source: envelope.source, handoffId: envelope.handoffId }, ctx),
    });
    try {
      await handoffReceiver.start();
      const handoffAck = await sendTelegramBusLocalEnvelope({ socketPath: handoffSocketPath,
        envelope: { kind: "leader.offerInputCustodyHandoff", requestId: "leader:handoff",
          recipientInstanceId: "recipient", recipientRegistrationGeneration: "g2",
          recipientBindingKey: "workspace:owner", sourceRecoveryKey: recoveryKey,
          source: offered.source, handoffId: offered.handoff.handoffId,
          sentAtMs: 1_999, auth: "shared-secret" } });
      assert.equal(handoffAck?.kind === "bus.ack" && handoffAck.ok, true);
      assert.equal(handoffAck?.kind === "bus.ack" &&
        (handoffAck.result as { duplicate?: boolean } | undefined)?.duplicate, true);
      assert.equal(wakes, 2);
      donor.appendBatch([{ update_id: 110 }], 110);
      const networkClaim = donor.acquireInput({ updateId: 110,
        recipientBindingKey: "workspace:owner" });
      let networkSends = 0;
      const networkClient = createTelegramInputCustodyHandoffClient({ journal: donor,
        resolveAcceptedReference: createTelegramInputCustodyForwardReferenceResolver({
          recoveryKey, recipientBindingKey: "workspace:owner", recipientOwner, journal: recipient }),
        async sendEnvelope(envelope) {
          networkSends += 1;
          return sendTelegramBusLocalEnvelope({ socketPath: handoffSocketPath, envelope });
        },
      });
      const networkInput = { requestId: "leader:handoff-110", receipt: networkClaim.receipt,
        recipientInstanceId: "recipient", recipientRegistrationGeneration: "g2",
        recipientBindingKey: "workspace:owner", recipientOwner,
        handoffToken: createTelegramUpdateQueueHandoffToken(), sentAtMs: 2_000,
        auth: "shared-secret" };
      const networkAccepted = await networkClient.transfer(networkInput);
      assert.equal(networkAccepted.duplicate, false);
      assert.equal(networkAccepted.source.updateId, 110);
      assert.equal(wakes, 3);
      assert.equal(networkSends, 1);
      assert.equal((await networkClient.transfer(networkInput)).duplicate, true);
      assert.equal(networkSends, 1);
      assert.equal(wakes, 3);
    } finally { await handoffReceiver.stop(); }
    const resolveReference = createTelegramInputCustodyForwardReferenceResolver({
      recoveryKey, recipientBindingKey: "workspace:owner", recipientOwner, journal: recipient });
    assert.deepEqual(resolveReference({ sourceUpdateId: 109,
      recipientBindingKey: "workspace:owner" }), { sourceRecoveryKey: recoveryKey,
      source: { updateId: 109, owner: { acquisitionId: accepted.source.owner.acquisitionId,
        handoffId: accepted.source.owner.handoffId } } });
    assert.equal(resolveReference({ sourceUpdateId: 109,
      recipientBindingKey: "workspace:other" }), undefined);
    let busBindingActive = true;
    const busBinding = createTelegramInputCustodyBusBindingRuntime({
      getForwardRecoveryKey: () => busBindingActive ? recoveryKey : undefined,
      resolveBinding: key => busBindingActive && key === recoveryKey ? { recoveryKey,
        recipientBindingKey: "workspace:owner", recipientOwner, journal: recipient,
        signalWorker() { wakes += 1; } } : undefined,
    });
    assert.deepEqual(busBinding.resolveForwardReference({ sourceUpdateId: 109,
      recipientBindingKey: "workspace:owner" }), resolveReference({ sourceUpdateId: 109,
      recipientBindingKey: "workspace:owner" }));
    const bindingWake = { deliveryId: "binding-wake", sourceUpdateId: 109,
      recipientBindingKey: "workspace:owner", sourceRecoveryKey: recoveryKey,
      sourceClaim: accepted.source.owner };
    busBinding.wakeSource(bindingWake, {});
    assert.equal(wakes, 4);
    busBindingActive = false;
    assert.equal(busBinding.resolveForwardReference({ sourceUpdateId: 109,
      recipientBindingKey: "workspace:owner" }), undefined);
    assert.throws(() => busBinding.wakeSource(bindingWake, {}),
      /binding is unavailable or changed/);
    assert.throws(() => busBinding.acceptHandoff({ sourceRecoveryKey: recoveryKey,
      recipientBindingKey: "workspace:owner", source: offered.source,
      handoffId: offered.handoff.handoffId }, {}), /binding is unavailable or changed/);
    assert.equal(wakes, 4);
    busBindingActive = true;
    donor.appendBatch([{ update_id: 111 }], 111);
    const secondClaim = donor.acquireInput({ updateId: 111,
      recipientBindingKey: "workspace:owner" });
    let handoffSends = 0;
    const client = createTelegramInputCustodyHandoffClient({ journal: donor,
      resolveAcceptedReference: resolveReference,
      async sendEnvelope(envelope) {
        handoffSends += 1;
        acceptance.accept({ sourceRecoveryKey: envelope.sourceRecoveryKey,
          recipientBindingKey: envelope.recipientBindingKey,
          source: envelope.source, handoffId: envelope.handoffId }, {});
        throw new Error("handoff acknowledgement lost");
      },
    });
    const transferInput = { requestId: "leader:handoff-111", receipt: secondClaim.receipt,
      recipientInstanceId: "recipient", recipientRegistrationGeneration: "g2",
      recipientBindingKey: "workspace:owner", recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken(), sentAtMs: 1_998 };
    await assert.rejects(client.transfer(transferInput), /handoff acknowledgement lost/);
    assert.equal(handoffSends, 1);
    const reconciled = await client.transfer(transferInput);
    assert.equal(reconciled.duplicate, true);
    assert.equal(reconciled.source.updateId, 111);
    assert.equal(handoffSends, 1);
    const runtime = createTelegramInputCustodySourceReferenceWakeRuntime({
      resolveBinding: key => key === recoveryKey ? { recoveryKey,
        recipientBindingKey: "workspace:owner", recipientOwner, journal: recipient,
        signalWorker() { wakes += 1; } } : undefined,
    });
    const input = { deliveryId: "delivery-109", sourceUpdateId: 109,
      recipientBindingKey: "workspace:owner", sourceRecoveryKey: recoveryKey,
      sourceClaim: { acquisitionId: accepted.source.owner.acquisitionId,
        handoffId: accepted.source.owner.handoffId } };
    runtime.wakeSource(input, {});
    assert.equal(wakes, 6);
    assert.throws(() => runtime.wakeSource({ ...input,
      sourceClaim: { ...input.sourceClaim, acquisitionId: "stale" } }, {}),
    /claim is unavailable or changed/);
    assert.throws(() => runtime.wakeSource({ ...input,
      recipientBindingKey: "workspace:other" }, {}), /binding is unavailable or changed/);
    assert.equal(wakes, 6);
    const delivery = createTelegramBusFollowerDeliveryIdentity({ kind: "leader.wakeInputCustody",
      recipientBindingKey: input.recipientBindingKey, sourceUpdateId: input.sourceUpdateId,
      sourceRecoveryKey: input.sourceRecoveryKey, sourceClaim: input.sourceClaim });
    const admission = createTelegramBusFollowerSourceReferenceAdmissionRuntime({
      wakeSource: runtime.wakeSource });
    const socketPath = join(dir, "source-reference.sock");
    const receiver = createTelegramBusForwardedUpdateReceiverRuntime({ socketPath,
      instanceId: "recipient", getAuthSecret: () => "shared-secret",
      getRegistrationGeneration: () => "g2", getRecipientBindingKey: () => "workspace:owner",
      durableAdmission: { async admit() { assert.fail("legacy copy admission invoked"); } },
      sourceReferenceAdmission: admission, isSourceReferenceAdmissionEnabled: () => true,
      hasAuthenticatedSourceReferenceTransport: () => true, getContext: () => ({}),
    });
    const send = (requestId: string, sourceDelivery = delivery, generation = "g2") =>
      sendTelegramBusLocalEnvelope({ socketPath, envelope: { kind: "leader.wakeInputCustody",
        requestId, recipientInstanceId: "recipient", recipientRegistrationGeneration: generation,
        delivery: sourceDelivery, sentAtMs: 2_000, auth: "shared-secret" } });
    try {
      await receiver.start();
      const capable = createTelegramBusProtocolIdentity({ runtimeBuild: "0.45.0",
        capabilities: [TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE] });
      const forwarder = createTelegramBusForeignOwnedUpdateForwarder({ socketPath,
        createRequestId: () => "leader:resolved", getNowMs: () => 2_000,
        getAuthSecret: () => "shared-secret",
        localProtocolIdentity: capable, resolveInputCustodyReference: resolveReference });
      const forwarded = await forwarder.forwardMessage({ message: {
        message_id: 109, text: "must-not-cross", pi_telegram_source_update_id: 109 }, ownership: {
        instanceId: "recipient", ownerGeneration: "g2", recipientBindingKey: "workspace:owner",
        protocolIdentity: capable }, ctx: {} });
      assert.equal(forwarded.status, "accepted");
      const replayed = await forwarder.forwardMessage({ message: {
        message_id: 109, text: "must-not-cross", pi_telegram_source_update_id: 109 }, ownership: {
        instanceId: "recipient", ownerGeneration: "g2", recipientBindingKey: "workspace:owner",
        protocolIdentity: capable }, ctx: {} });
      assert.deepEqual(replayed, forwarded);
      assert.equal(wakes, 7);
      const first = await send("leader:accepted-1");
      const duplicateWake = await send("leader:accepted-2");
      assert.equal(first?.kind === "bus.ack" && first.ok, true);
      assert.equal(duplicateWake?.kind === "bus.ack" && duplicateWake.ok, true);
      assert.equal(wakes, 9);
      const staleDelivery = { ...delivery,
        sourceClaim: { ...delivery.sourceClaim!, acquisitionId: "stale" } };
      const stale = await send("leader:stale-claim", staleDelivery);
      assert.equal(stale?.kind === "bus.ack" && stale.ok, false);
      const replaced = await send("leader:stale-generation", delivery, "g1");
      assert.equal(replaced?.kind === "bus.ack" && replaced.ok, false);
      assert.equal(wakes, 9);
    } finally { await receiver.stop(); }
  });
});

test("V3 lifecycle lookup accepts one exact queued handoff for recipient owner", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const donor = createTelegramInputJournalStore(options);
    donor.appendBatch([{ update_id: 110 }], 110);
    const raw = donor.acquireInput({ updateId: 110, recipientBindingKey: "workspace:owner" });
    assert.equal(donor.startInput(raw.receipt).started, true);
    const queued = donor.queueInputs({ queueKind: "prompt", receiptId: "lookup-handoff",
      receipts: [raw.receipt] }).queueReceipt;
    const recipientRuntime = { instanceId: "recipient", processId: process.pid + 4,
      processBirthId: `${process.pid + 4}:recipient` };
    const recipientOwner = { ...recipientRuntime, sessionGeneration: 1 };
    const handoff = { queueKind: queued.queueKind, receiptId: queued.receiptId,
      sourceUpdateIds: queued.sourceUpdateIds, expectedOwner: queued.queueOwner, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() };
    donor.offerQueuedHandoff(handoff);
    const recipient = createTelegramInputJournalStore({ ...options,
      queueRuntimeIdentity: recipientRuntime,
      getInputContext: () => ({ owner: recipientOwner, recipientBindingKey: "workspace:owner" }) });
    const resolve = createTelegramInputCustodyLifecycleBindingResolver({ isEnabled: () => true,
      resolveInputJournal: () => ({ runtimeKey: "recipient-v3",
        recoveryKey: createTelegramUpdateJournalBindingKey(options), journal: recipient }),
      getRecipientBindingKey: () => "workspace:owner" });
    const runtimeBinding = createTelegramUpdateAdmissionRuntimeBinding({
      isFollowerRegistered: () => true });
    const lifecycleBus = createTelegramInputCustodyBusBindingRuntime({
      getForwardRecoveryKey: () => undefined, resolveBinding: () => undefined });
    const referenceEvents: string[] = [];
    const assembly = createTelegramUpdateAdmissionLifecycleAssembly({ runtimeBinding,
      inputCustodyBus: lifecycleBus,
      acquireSourceReference(role, binding) {
        referenceEvents.push(`acquire:${role}:${binding.recoveryKey}`);
        let released = false;
        return () => { assert.equal(released, false); released = true;
          referenceEvents.push(`release:${role}:${binding.recoveryKey}`); };
      },
      worker: { getQueueOwnerIdentity: () => recipientOwner, async defaultHandle() {} },
      leader: { resolveBinding: () => undefined, hasAuthority: () => false },
      follower: { resolveBinding: resolve, isRegistered: () => true,
        getGeneration: () => "g1", prepareUpdateForExecution: update => update },
    });
    try {
      assert.equal(runtimeBinding.getInputCustodyBus(), lifecycleBus);
      await assembly.follower.onSessionStart({});
      const lifecycle = runtimeBinding.getLifecycleForJournalBinding(
        createTelegramUpdateJournalBindingKey(options));
      assert.ok(lifecycle);
      const accepted = lifecycle.acceptQueueReceiptHandoff(handoff);
      assert.deepEqual(accepted.acceptedUpdateIds, [110]);
      assert.equal(accepted.queueOwner.instanceId, "recipient");
      const duplicate = lifecycle.acceptQueueReceiptHandoff(handoff);
      assert.equal(duplicate.duplicate, true);
      assert.deepEqual(duplicate.queueOwner, accepted.queueOwner);
      assert.deepEqual(recipient.read().entries[0]?.queueOwner, accepted.queueOwner);
      await assembly.follower.onTransportChanged({});
      assert.deepEqual(referenceEvents.map(event => event.split(":")[0]),
        ["acquire", "release", "acquire"]);
      const receipt = { queueKind: queued.queueKind, receiptId: queued.receiptId,
        sourceUpdateIds: queued.sourceUpdateIds,
        journalBindingKey: createTelegramUpdateJournalBindingKey(options) };
      assert.deepEqual(runtimeBinding.getLifecycleForJournalBinding(receipt.journalBindingKey)
        ?.getQueueReceiptOwner(receipt), accepted.queueOwner);

    } finally { await assembly.follower.onSessionShutdown(); }
    assert.deepEqual(referenceEvents.map(event => event.split(":")[0]),
      ["acquire", "release", "acquire", "release"]);
    await assembly.follower.onSessionStart({});
    await assembly.follower.onSessionShutdown();
    assert.deepEqual(referenceEvents.map(event => event.split(":")[0]),
      ["acquire", "release", "acquire", "release", "acquire", "release"]);
  });
});

test("Input custody refuses vetoes and revoked publication without losing a retryable acquisition", async context => {
  await withInputCustodyFixture(context, async ({ options, path, setOwner, setBinding, setHook }) => {
    const excluded = createTelegramInputJournalStore({ ...options,
      withPairingAdmission: publish => options.withSourceSerialization(() => publish(true)) });
    excluded.appendBatch([{ update_id: 1 }], 1);
    assert.throws(() => excluded.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" }),
      (error) => isJournalError(error, "conflict"));
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 2 }], 2);
    const identity = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    const before = store.read();
    setHook(boundary => { if (boundary === "after-write-before-rename") setOwner(undefined); });
    assert.throws(() => store.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" }),
      (error) => isJournalError(error, "conflict"));
    assert.deepEqual(store.read(), before);
    assert.equal(existsSync(`${path}.transaction`), false);
    setHook(undefined); setOwner(identity);
    const acquired = store.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
    const ready = store.read();
    setHook(boundary => { if (boundary === "after-write-before-rename") setOwner({ ...identity, sessionGeneration: 2 }); });
    assert.throws(() => store.startInput(acquired.receipt), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(store.read(), ready);
    setOwner(identity);
    setHook(boundary => { if (boundary === "after-write-before-rename") setBinding("workspace:replacement"); });
    assert.throws(() => store.startInput(acquired.receipt), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(store.read(), ready);
    setBinding("workspace:owner"); setHook(undefined);
    assert.equal(store.startInput(acquired.receipt).started, true);
    assert.deepEqual(store.completeInput(acquired.receipt).removedUpdateIds, [2]);
  });
});

test("Input custody never regrants a start whose compaction failed after durable publication", async context => {
  await withInputCustodyFixture(context, async ({ options, path, setHook }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 1 }], 1);
    const { receipt } = store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    for (let cursor = 2; cursor <= 255; cursor++) store.appendBatch([], cursor);
    setHook((boundary, target) => {
      if (boundary === "before-write" && target === path) throw new Error("compaction publication failed");
    });
    assert.throws(() => store.startInput(receipt), (error) => isJournalError(error, "io"));
    assert.equal(store.read().entries[0]!.inputClaim!.phase, "running");
    assert.deepEqual(store.startInput(receipt), { started: false });
    assert.equal(existsSync(`${path}.transaction`), false);
    // This is commit-unknown, not evidence that a user handler actually ran.
  });
});

test("Input custody serializes competing process acquisitions without dead-owner takeover", async context => {
  await withInputCustodyFixture(context, async ({ options, path }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 42 }], 42);
    await Promise.all([runJournalWorker(path, 1, 42, "input-custody"), runJournalWorker(path, 2, 42, "input-custody")]);
    const results = await Promise.all([1, 2].map(async index => JSON.parse(await readFile(`${path}.claim-${index}.json`, "utf8"))));
    assert.equal(results.filter(result => result.acquired).length, 1);
    assert.equal(results.filter(result => result.refused === "conflict").length, 1);
    const winner = results.find(result => result.acquired);
    assert.equal(winner.started, true);
    assert.deepEqual(store.read().entries[0]!.inputClaim!.owner, winner.receipt.owner);
    assert.equal(store.read().entries[0]!.inputClaim!.phase, "running");
    assert.throws(() => store.acquireInput({ updateId: 42, recipientBindingKey: "workspace:owner" }),
      (error) => isJournalError(error, "conflict"));
    assert.throws(() => store.completeInput(winner.receipt), (error) => isJournalError(error, "conflict"));
  });
});

test("Input custody captures configuration, refuses capacity, and retains stored receipt scope", async context => {
  await withInputCustodyFixture(context, async ({ options, path }) => {
    for (const field of ["sourceAccess", "queueRuntimeIdentity", "withSourceSerialization", "withPairingAdmission", "getInputContext"]) {
      assert.throws(() => createTelegramInputJournalStore({ ...options, [field]: undefined } as unknown as TelegramInputJournalStoreOptions),
        /requires strict serialized polling admission/);
    }
    const captured = { ...options, queueRuntimeIdentity: { ...options.queueRuntimeIdentity } };
    let getterReads = 0;
    Object.defineProperty(captured, "getInputContext", { enumerable: true, get() { getterReads++; return options.getInputContext; } });
    const store = createTelegramInputJournalStore(captured);
    assert.equal(getterReads, 1);
    captured.queueRuntimeIdentity.instanceId = "caller mutation";
    store.appendBatch([{ update_id: 1 }], 1);
    const bytes = await readFile(path, "utf8");
    const tight = createTelegramInputJournalStore({ ...options, maxBytes: store.read().serializedBytes });
    const request = { updateId: 1, recipientBindingKey: "workspace:owner" };
    assert.throws(() => tight.acquireInput(request), (error) => isJournalError(error, "capacity"));
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(existsSync(`${path}.segments`), false);
    assert.equal(existsSync(`${path}.transaction`), false);
    const acquired = store.acquireInput(request);
    const enriched = createTelegramInputJournalStore({ ...options, botIdentity: { ...options.botIdentity, botId: 77 } });
    assert.throws(() => enriched.acquireInput(request), (error) => isJournalError(error, "identity-mismatch"));
    assert.equal(store.read().botIdentity.botId, undefined);
    assert.equal(acquired.receipt.journalBindingKey, createTelegramUpdateJournalBindingKey(options));
    assert.throws(() => store.startInput({ ...acquired.receipt, tokenSha256: "f".repeat(64) }),
      (error) => isJournalError(error, "conflict"));
    assert.equal(store.startInput(acquired.receipt).started, true);
    assert.deepEqual(store.completeInput(acquired.receipt).removedUpdateIds, [1]);
    assert.throws(() => store.completeInput({ ...acquired.receipt, journalBindingKey: "other source" }),
      (error) => isJournalError(error, "conflict"));
  });
});

test("Input custody removes only immutable exclusions atomically and preserves the replay barrier", async context => {
  await withInputCustodyFixture(context, async ({ options, path, dir, setOwner, ledger }) => {
    const store = createTelegramInputJournalStore(options);
    assert.throws(() => store.removeExcluded([1]), (error) => isJournalError(error, "conflict"));
    assert.equal(existsSync(path), false);
    const excluded = createTelegramInputJournalStore({ ...options,
      withPairingAdmission: publish => options.withSourceSerialization(() => publish(true)) });
    excluded.appendBatch([{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }], 3);
    store.appendBatch([{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }], 12);
    const ready = store.acquireInput({ updateId: 11, recipientBindingKey: "workspace:owner" });
    const running = store.acquireInput({ updateId: 12, recipientBindingKey: "workspace:owner" });
    assert.equal(store.startInput(running.receipt).started, true);
    const before = store.read();
    const names = await readdir(dir);
    for (const ids of [[1, 10], [1, 11], [1, 12], [1, 13], [1, -1], [1, Number.NaN]]) {
      assert.throws(() => store.removeExcluded(ids), TelegramUpdateJournalError);
      assert.deepEqual(store.read(), before);
      assert.deepEqual(await readdir(dir), names);
      assert.deepEqual(ledger.read().leases, []);
    }
    // The immutable veto, not a live execution context or configured sender, permits removal.
    setOwner(undefined);
    await writeFile(join(dir, "telegram.json"), JSON.stringify({ profiles: { work: { botToken: "123:synthetic-input-custody" } } }));
    const ids = [2, 1, 2, 4];
    const captured = createTelegramInputJournalStore({ ...options,
      withSourceSerialization(operation) {
        assert.ok(ledger.read().leases.some(lease => lease.scope.kind === "profile"));
        ids.push(10);
        return options.withSourceSerialization(operation);
      } });
    assert.deepEqual(captured.removeExcluded(ids).removedUpdateIds, [1, 2]);
    assert.deepEqual(store.removeExcluded([1, 2, 4]).removedUpdateIds, []);
    assert.deepEqual(store.removeExcluded([]).removedUpdateIds, []);
    assert.deepEqual(store.appendBatch([{ update_id: 1 }, { update_id: 2 }, { update_id: 4 }], 12).addedUpdateIds, []);
    assert.deepEqual(createTelegramInputJournalStore(options).removeExcluded([3]).removedUpdateIds, [3]);
    assert.deepEqual(store.read().entries, before.entries.filter(entry => entry.updateId >= 10));
    assert.deepEqual(store.read().entries[1]!.inputClaim!.owner, ready.receipt.owner);
    assert.equal(store.read().entries[2]!.inputClaim!.phase, "running");
    assert.equal(store.read().acceptedThroughUpdateId, 12);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody exclusion removal preserves failure diagnostics outside the veto and retries publication safely", async context => {
  await withInputCustodyFixture(context, async ({ options, path, dir, setHook, setOwner }) => {
    const failure = { attemptCount: 1, failedAtMs: 101, failureClass: "fixture", summary: "fixture failure" };
    const entries = [true, false].flatMap((preApprovalExcluded, group) =>
      (["pending", "retry-wait", "failed"] as const).map((state, index) => {
        const updateId = group * 10 + index + 1;
        return { updateId, update: { update_id: updateId }, admittedAtMs: 100, preApprovalExcluded, state,
          ...(state === "pending" ? {} : { failure }), ...(state === "retry-wait" ? { nextRetryAtMs: 102 } : {}),
          ...(state === "failed" ? { terminalAtMs: 102, terminalReason: "fixture terminal" } : {}) };
      }));
    const queued = { updateId: 14, update: { update_id: 14 }, admittedAtMs: 100, preApprovalExcluded: false,
      state: "queued", queueKind: "prompt", queueReceiptId: "fixture-receipt",
      queueOwner: { ...options.queueRuntimeIdentity, sessionGeneration: 1, acquisitionId: "fixture-queue", acquiredAtMs: 101 } };
    await writeFile(path, JSON.stringify({ version: 3, profile: "work", botIdentity: options.botIdentity,
      entries: [...entries, queued], acceptedThroughUpdateId: 14 }));
    const store = createTelegramInputJournalStore(options);
    setOwner(undefined);
    const before = store.read();
    for (const id of [11, 12, 13, 14]) {
      assert.throws(() => store.removeExcluded([1, id]), (error) => isJournalError(error, "conflict"));
      assert.deepEqual(store.read(), before);
    }
    const bytes = await readFile(path, "utf8");
    const malformed = JSON.parse(bytes);
    delete malformed.entries.at(-1).preApprovalExcluded;
    const malformedBytes = JSON.stringify(malformed);
    await writeFile(path, malformedBytes);
    assert.throws(() => store.removeExcluded([1]), (error) => isJournalError(error, "pairing-evidence"));
    assert.equal(await readFile(path, "utf8"), malformedBytes);
    assert.equal(existsSync(`${path}.transaction`), false);
    await writeFile(path, bytes);
    const tight = createTelegramInputJournalStore({ ...options,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 1 } } });
    assert.throws(() => tight.removeExcluded([1, 2, 3]), (error) => isJournalError(error, "capacity"));
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(existsSync(`${path}.segments`), false);
    setHook(boundary => { if (boundary === "after-write-before-rename") throw new Error("fixture publication failure"); });
    assert.throws(() => store.removeExcluded([1, 2, 3]), (error) => isJournalError(error, "io"));
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.deepEqual(store.read(), before);
    assert.equal(existsSync(`${path}.transaction`), false);
    assert.deepEqual((await readdir(dir)).filter(name => name.startsWith("inbox.work.json")), ["inbox.work.json", "inbox.work.json.segments"]);
    assert.deepEqual(await readdir(`${path}.segments`), []);
    setHook(undefined);
    assert.deepEqual(store.removeExcluded([3, 1, 2]).removedUpdateIds, [1, 2, 3]);
    assert.deepEqual(store.read().entries, before.entries.filter(entry => !entry.preApprovalExcluded));
    const after = store.read();
    setHook(() => assert.fail("A repeated exclusion removal must not publish"));
    assert.deepEqual(createTelegramInputJournalStore(options).removeExcluded([1, 2, 3]).removedUpdateIds, []);
    assert.deepEqual(store.read(), after);
  });
});

test("Input custody reserves one ready release and complete transition chain before durable admission", async context => {
  await withInputCustodyFixture(context, async ({ options, dir, ledger }) => {
    const calibrationPath = join(dir, "calibration.json");
    const calibration = createTelegramInputJournalStore({ ...options, path: calibrationPath });
    const rawBytes = calibration.appendBatch([{ update_id: 1 }], 1).serializedBytes;
    for (const [name, override] of [
      ["logical", { maxBytes: rawBytes }],
      ["files", { sourceAccess: { ...options.sourceAccess,
        limits: { ...options.sourceAccess.limits, maxFiles: 5 } } }],
      ["physical-bytes", { sourceAccess: { ...options.sourceAccess,
        limits: { ...options.sourceAccess.limits, maxBytes: rawBytes } } }],
      ["work", { sourceAccess: { ...options.sourceAccess,
        limits: { ...options.sourceAccess.limits, maxWork: 1 } } }],
    ] as const) {
      const path = join(dir, `bounded-${name}.json`);
      const bounded = createTelegramInputJournalStore({ ...options, path, ...override });
      assert.throws(() => bounded.appendBatch([{ update_id: 1 }], 1), (error) => isJournalError(error, "capacity"), name);
      assert.equal(existsSync(path), false, name);
      assert.equal(existsSync(`${path}.segments`), false, name);
      assert.equal(existsSync(`${path}.transaction`), false, name);
      assert.deepEqual(ledger.read().leases, [], name);
    }
    const path = join(dir, "six-files.json");
    const store = createTelegramInputJournalStore({ ...options, path,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 6 } } });
    store.appendBatch([{ update_id: 2 }], 2);
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = ((target: fs.PathLike) => {
      if (String(target).startsWith(`${path}.segments/`)) throw new Error("synthetic retained segment");
      return originalUnlink(target);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try {
      const first = store.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
      assert.equal(store.releaseInput(first.receipt).released, true);
      const second = store.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
      assert.equal(store.startInput(second.receipt).started, true);
      assert.deepEqual(store.completeInput(second.receipt).removedUpdateIds, [2]);
    } finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
    assert.deepEqual(store.read().entries, []);
    assert.equal((await readdir(`${path}.segments`)).length, 5);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody reserves progress when append snapshot publication is commit-unknown", async context => {
  await withInputCustodyFixture(context, async ({ options, dir, setHook }) => {
    const path = join(dir, "commit-unknown-append.json");
    const store = createTelegramInputJournalStore({ ...options, path,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 7 } } });
    store.appendBatch([{ update_id: 1 }], 1);
    setHook((boundary, target) => {
      if (boundary === "after-write-before-rename" && target === path) throw new Error("snapshot commit unknown");
    });
    assert.throws(() => store.appendBatch([{ update_id: 2 }], 2), (error) => isJournalError(error, "io"));
    setHook(undefined);
    assert.deepEqual(store.read().entries.map(entry => entry.updateId), [1, 2]);
    assert.deepEqual(store.appendBatch([{ update_id: 2 }], 2).duplicateUpdateIds, [2]);
    const claimed = store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    assert.equal(store.startInput(claimed.receipt).started, true);
    assert.deepEqual(store.completeInput(claimed.receipt).removedUpdateIds, [1]);
    const next = store.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
    assert.equal(store.startInput(next.receipt).started, true);
    assert.deepEqual(store.completeInput(next.receipt).removedUpdateIds, [2]);
    assert.deepEqual(store.read().entries, []);
    const insufficientPath = join(dir, "commit-unknown-insufficient.json");
    const insufficient = createTelegramInputJournalStore({ ...options, path: insufficientPath,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 6 } } });
    insufficient.appendBatch([{ update_id: 1 }], 1);
    setHook(() => assert.fail("Insufficient commit-unknown headroom must refuse before publication"));
    assert.throws(() => insufficient.appendBatch([{ update_id: 2 }], 2), (error) => isJournalError(error, "capacity"));
    setHook(undefined);
    assert.deepEqual(insufficient.read().entries.map(entry => entry.updateId), [1]);
    assert.equal(existsSync(`${insufficientPath}.segments`), false);
  });
});

test("Input custody bounds execution projection growth inside its admission reserve", async context => {
  await withInputCustodyFixture(context, async ({ options }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 1, message: { text: "original" } }], 1);
    const before = store.read();
    assert.throws(() => store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner",
      executionUpdate: { update_id: 1, message: { text: "x".repeat(16 * 1024) } } }),
    (error) => isJournalError(error, "capacity"));
    assert.deepEqual(store.read(), before);
    assert.throws(() => store.acquireInput({ updateId: 1, recipientBindingKey: "x".repeat(257) }),
      (error) => isJournalError(error, "invalid"));
    assert.deepEqual(store.read(), before);
    const acquired = store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner",
      executionUpdate: { update_id: 1, message: { text: "routed", message_thread_id: 9 } } });
    assert.equal(acquired.acquired, true);
    const bounded = createTelegramInputJournalStore({ ...options, path: join(dirname(options.path), "bounded-projection.json"),
      maxBytes: 20_000 });
    bounded.appendBatch([{ update_id: 10 }], 10);
    const running = bounded.acquireInput({ updateId: 10, recipientBindingKey: "workspace:owner" });
    assert.equal(bounded.startInput(running.receipt).started, true);
    const boundedBefore = bounded.read();
    assert.throws(() => bounded.appendBatch([{ update_id: 11, message: { text: "x".repeat(8_000) } }], 11),
      (error) => isJournalError(error, "capacity"));
    assert.deepEqual(bounded.read(), boundedBefore);
    assert.deepEqual(bounded.completeInput(running.receipt).removedUpdateIds, [10]);
  });
});

test("Input custody releases only an exact ready claim and retries commit-unknown publication", async context => {
  await withInputCustodyFixture(context, async ({ options, path, setOwner, setHook }) => {
    const identity = { ...options.queueRuntimeIdentity, sessionGeneration: 1 };
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 1, message: { text: "retained" } }], 1);
    const first = store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    const ready = store.read();
    const readyBytes = await readFile(path, "utf8");
    const handedOff = JSON.parse(readyBytes);
    handedOff.entries[0].inputClaim.handoff = { handoffId: `input-handoff-${"1".repeat(32)}`, offeredAtMs: 1,
      recipientOwner: { instanceId: "recipient", processId: process.pid + 1,
        processBirthId: `${process.pid + 1}:recipient`, sessionGeneration: 1 } };
    await writeFile(path, JSON.stringify(handedOff));
    assert.throws(() => store.releaseInput(first.receipt), (error) => isJournalError(error, "conflict"));
    assert.equal(await readFile(path, "utf8"), JSON.stringify(handedOff));
    await writeFile(path, readyBytes);
    setOwner(undefined);
    assert.throws(() => store.releaseInput({ ...first.receipt,
      owner: { ...first.receipt.owner, acquisitionId: "stale" } }), (error) => isJournalError(error, "conflict"));
    let interrupt = true;
    setHook(boundary => { if (interrupt && boundary === "after-write-before-rename") throw new Error("pre-commit release failure"); });
    assert.throws(() => store.releaseInput(first.receipt), (error) => isJournalError(error, "io"));
    assert.deepEqual(store.read(), ready);
    interrupt = false;
    let boundaryCount = 0;
    setHook(boundary => {
      boundaryCount += 1;
      if (boundaryCount === 3 && boundary === "before-write") throw new Error("release snapshot commit unknown");
    });
    assert.throws(() => store.releaseInput(first.receipt), (error) => isJournalError(error, "io"));
    setHook(undefined);
    assert.equal(store.read().entries[0]!.inputClaim, undefined);
    assert.deepEqual(store.releaseInput(first.receipt), { released: false,
      entryCount: 1, serializedBytes: store.read().serializedBytes });
    assert.equal((store.read().entries[0]!.update.message as { text: string }).text, "retained");
    setOwner(identity);
    const second = store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    assert.throws(() => store.releaseInput(first.receipt), (error) => isJournalError(error, "conflict"));
    assert.equal(store.startInput(second.receipt).started, true);
    const running = store.read();
    assert.throws(() => store.releaseInput(second.receipt), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(store.read(), running);
    assert.deepEqual(store.completeInput(second.receipt).removedUpdateIds, [1]);
    assert.equal(existsSync(`${path}.transaction`), false);
  });
});

test("Input custody recovers ready ownership only after exact process-death proof", async context => {
  await withInputCustodyFixture(context, async ({ options, path, ledger }) => {
    const ownerStore = createTelegramInputJournalStore(options);
    ownerStore.appendBatch([{ update_id: 1 }], 1);
    const first = ownerStore.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    const recoveryRuntime = { instanceId: "recovery", processId: process.pid + 1000,
      processBirthId: `${process.pid + 1000}:recovery` };
    const recoveryOwner = { ...recoveryRuntime, sessionGeneration: 2 };
    let liveness: "alive" | "dead" | "unverifiable" = "alive";
    let livenessCalls = 0;
    let throwLiveness = false;
    const recovery = createTelegramInputJournalStore({ ...options, queueRuntimeIdentity: recoveryRuntime,
      getInputContext: () => ({ owner: recoveryOwner, recipientBindingKey: "workspace:owner" }),
      getQueueProcessLiveness(observed) {
        livenessCalls += 1;
        assert.deepEqual(observed, { processId: first.receipt.owner.processId,
          processBirthId: first.receipt.owner.processBirthId });
        assert.ok(ledger.read().leases.some(lease => lease.scope.kind === "profile"));
        if (throwLiveness) throw new Error("synthetic liveness failure");
        return liveness;
      } });
    assert.throws(() => recovery.recoverReadyInput({ receipt: first.receipt,
      recoveryOwner: { ...recoveryOwner, instanceId: "foreign" } }), (error) => isJournalError(error, "conflict"));
    assert.equal(livenessCalls, 0);
    for (const [value, status] of [["alive", "owner-alive"], ["unverifiable", "owner-unverifiable"]] as const) {
      liveness = value;
      assert.equal(recovery.recoverReadyInput({ receipt: first.receipt, recoveryOwner }).status, status);
      assert.deepEqual(ownerStore.read().entries[0]!.inputClaim!.owner, first.receipt.owner);
    }
    throwLiveness = true;
    assert.throws(() => recovery.recoverReadyInput({ receipt: first.receipt, recoveryOwner }),
      (error) => isJournalError(error, "io"));
    throwLiveness = false; liveness = "dead";
    assert.equal(recovery.recoverReadyInput({ receipt: first.receipt, recoveryOwner }).status, "recovered");
    assert.equal(ownerStore.read().entries[0]!.inputClaim, undefined);
    const calls = livenessCalls;
    assert.equal(recovery.recoverReadyInput({ receipt: first.receipt, recoveryOwner }).status, "unclaimed");
    assert.equal(livenessCalls, calls);
    const next = recovery.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    assert.throws(() => ownerStore.releaseInput(next.receipt), (error) => isJournalError(error, "conflict"));
    assert.equal(recovery.startInput(next.receipt).started, true);
    const running = recovery.read();
    assert.throws(() => recovery.recoverReadyInput({ receipt: next.receipt, recoveryOwner }),
      (error) => isJournalError(error, "conflict"));
    assert.equal(livenessCalls, calls);
    assert.deepEqual(recovery.read(), running);
    assert.deepEqual(recovery.completeInput(next.receipt).removedUpdateIds, [1]);
    assert.equal(existsSync(`${path}.transaction`), false);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody offer freezes the donor and acceptance transfers one exact acquisition", async context => {
  await withInputCustodyFixture(context, async ({ options, ledger }) => {
    const donor = createTelegramInputJournalStore(options);
    donor.appendBatch([{ update_id: 1, message: { text: "original" } }], 1);
    const donorClaim = donor.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner",
      executionUpdate: { update_id: 1, message: { text: "routed", message_thread_id: 9 } } });
    const recipientRuntime = { instanceId: "recipient", processId: process.pid + 2000,
      processBirthId: `${process.pid + 2000}:recipient` };
    const recipientOwner = { ...recipientRuntime, sessionGeneration: 2 };
    const handoff = { receipt: donorClaim.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() };
    const readyBytes = await readFile(options.path, "utf8");
    assert.throws(() => donor.offerInputHandoff({ ...handoff, handoffToken: "short" }),
      (error) => isJournalError(error, "invalid"));
    assert.throws(() => donor.offerInputHandoff({ ...handoff, recipientOwner: {
      instanceId: donorClaim.receipt.owner.instanceId, processId: donorClaim.receipt.owner.processId,
      processBirthId: donorClaim.receipt.owner.processBirthId, sessionGeneration: 2 } }),
    (error) => isJournalError(error, "conflict"));
    assert.equal(await readFile(options.path, "utf8"), readyBytes);
    const offered = donor.offerInputHandoff(handoff);
    assert.equal(offered.duplicate, false);
    assert.deepEqual(offered.source, inputSource(donorClaim.receipt));
    assert.match(offered.handoff.handoffId, /^input-handoff-[a-f0-9]{32}$/u);
    assert.deepEqual(offered.previousOwner, donorClaim.receipt.owner);
    const frozen = donor.read();
    assert.deepEqual(frozen.entries[0]!.inputClaim!.handoff, offered.handoff);
    assert.deepEqual(frozen.entries[0]!.inputClaim!.executionUpdate,
      { update_id: 1, message: { text: "routed", message_thread_id: 9 } });
    assert.equal(donor.offerInputHandoff(handoff).duplicate, true);
    const reconstructedOffer = donor.offerInputHandoff({ ...handoff,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    assert.equal(reconstructedOffer.duplicate, true);
    assert.deepEqual(reconstructedOffer.handoff, offered.handoff);
    assert.throws(() => donor.offerInputHandoff({ ...handoff,
      recipientOwner: { ...recipientOwner, sessionGeneration: 3 } }),
    (error) => isJournalError(error, "conflict"));
    const acceptance = { source: offered.source, recipientOwner,
      handoffId: offered.handoff.handoffId };
    const cancellation = { receipt: donorClaim.receipt, recipientOwner,
      handoffId: offered.handoff.handoffId };
    assert.throws(() => donor.startInput(donorClaim.receipt), (error) => isJournalError(error, "conflict"));
    assert.throws(() => donor.releaseInput(donorClaim.receipt), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(donor.read(), frozen);
    const wrongBinding = createTelegramInputJournalStore({ ...options, queueRuntimeIdentity: recipientRuntime,
      getInputContext: () => ({ owner: recipientOwner, recipientBindingKey: "workspace:other" }) });
    assert.throws(() => wrongBinding.acceptInputHandoff(acceptance), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(donor.read(), frozen);
    const recipient = createTelegramInputJournalStore({ ...options, queueRuntimeIdentity: recipientRuntime,
      getInputContext: () => ({ owner: recipientOwner, recipientBindingKey: "workspace:owner" }) });
    assert.throws(() => recipient.acceptInputHandoff({ ...acceptance,
      handoffId: `input-handoff-${"0".repeat(32)}` }), (error) => isJournalError(error, "conflict"));
    const accepted = recipient.acceptInputHandoff(acceptance);
    assert.equal(accepted.duplicate, false);
    assert.notEqual(accepted.receipt.owner.acquisitionId, donorClaim.receipt.owner.acquisitionId);
    assert.equal(accepted.receipt.owner.handoffId, offered.handoff.handoffId);
    const acceptedSnapshot = recipient.read();
    assert.equal(acceptedSnapshot.entries[0]!.inputClaim!.handoff, undefined);
    assert.deepEqual(acceptedSnapshot.entries[0]!.inputClaim!.owner, accepted.receipt.owner);
    assert.equal(recipient.acceptInputHandoff(acceptance).duplicate, true);
    assert.deepEqual(recipient.acceptInputHandoff(acceptance).receipt, accepted.receipt);
    assert.throws(() => donor.cancelInputHandoff(cancellation), (error) => isJournalError(error, "conflict"));
    const started = recipient.startInput(accepted.receipt);
    assert.deepEqual(started, { started: true,
      update: { update_id: 1, message: { text: "routed", message_thread_id: 9 } } });
    const lateDuplicate = recipient.acceptInputHandoff(acceptance);
    assert.equal(lateDuplicate.duplicate, true);
    assert.equal(lateDuplicate.handoffId, accepted.handoffId);
    assert.deepEqual(lateDuplicate.receipt, accepted.receipt);
    assert.equal(lateDuplicate.entryCount, 1);
    assert.equal(lateDuplicate.serializedBytes, recipient.read().serializedBytes);
    assert.equal(lateDuplicate.previousOwner, undefined);
    assert.throws(() => donor.startInput(donorClaim.receipt), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(recipient.completeInput(accepted.receipt).removedUpdateIds, [1]);
    assert.throws(() => recipient.acceptInputHandoff(acceptance), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(donor.appendBatch([{ update_id: 1 }], 1).addedUpdateIds, []);
    assert.deepEqual(donor.read().entries, []);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody handoff cancellation, recovery, and commit-unknown acceptance never restore donor authority", async context => {
  await withInputCustodyFixture(context, async ({ options, path, setHook, ledger }) => {
    const donor = createTelegramInputJournalStore(options);
    donor.appendBatch([{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }], 3);
    const recipientRuntime = { instanceId: "recipient", processId: process.pid + 3000,
      processBirthId: `${process.pid + 3000}:recipient` };
    const recipientOwner = { ...recipientRuntime, sessionGeneration: 2 };
    let liveness: "alive" | "unverifiable" | "dead" = "dead";
    let livenessCalls = 0;
    const recovery = createTelegramInputJournalStore({ ...options, queueRuntimeIdentity: recipientRuntime,
      getInputContext: () => ({ owner: recipientOwner, recipientBindingKey: "workspace:owner" }),
      getQueueProcessLiveness: () => { livenessCalls += 1; return liveness; } });

    const first = donor.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    const firstOffer = donor.offerInputHandoff({ receipt: first.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    const firstAcceptance = { source: firstOffer.source, recipientOwner,
      handoffId: firstOffer.handoff.handoffId };
    let boundaries = 0;
    setHook(boundary => {
      boundaries += 1;
      if (boundaries === 3 && boundary === "before-write") throw new Error("accept snapshot commit unknown");
    });
    assert.throws(() => recovery.acceptInputHandoff(firstAcceptance), (error) => isJournalError(error, "io"));
    setHook(undefined);
    const accepted = recovery.acceptInputHandoff(firstAcceptance);
    assert.equal(accepted.duplicate, true);
    assert.throws(() => recovery.recoverReadyInput({ receipt: first.receipt, recoveryOwner: recipientOwner }),
      (error) => isJournalError(error, "conflict"));
    assert.equal(livenessCalls, 0);
    assert.equal(recovery.startInput(accepted.receipt).started, true);
    assert.throws(() => donor.cancelInputHandoff({ receipt: first.receipt, recipientOwner,
      handoffId: firstOffer.handoff.handoffId }), (error) => isJournalError(error, "conflict"));
    assert.deepEqual(recovery.completeInput(accepted.receipt).removedUpdateIds, [1]);

    const second = donor.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
    const secondHandoff = { receipt: second.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() };
    boundaries = 0;
    setHook(boundary => {
      boundaries += 1;
      if (boundaries === 3 && boundary === "before-write") throw new Error("offer snapshot commit unknown");
    });
    assert.throws(() => donor.offerInputHandoff(secondHandoff), (error) => isJournalError(error, "io"));
    setHook(undefined);
    const offered = donor.offerInputHandoff({ ...secondHandoff,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    assert.equal(offered.duplicate, true);
    const cancellation = { receipt: second.receipt, recipientOwner, handoffId: offered.handoff.handoffId };
    const offeredBytes = await readFile(path, "utf8");
    assert.throws(() => donor.cancelInputHandoff({ ...cancellation,
      handoffId: `input-handoff-${"0".repeat(32)}` }), (error) => isJournalError(error, "conflict"));
    assert.equal(await readFile(path, "utf8"), offeredBytes);
    boundaries = 0;
    setHook(boundary => {
      boundaries += 1;
      if (boundaries === 3 && boundary === "before-write") throw new Error("cancel snapshot commit unknown");
    });
    assert.throws(() => donor.cancelInputHandoff(cancellation), (error) => isJournalError(error, "io"));
    setHook(undefined);
    assert.equal(donor.cancelInputHandoff(cancellation).cancelled, false);
    assert.equal(donor.read().entries.find(entry => entry.updateId === 2)!.inputClaim!.handoff, undefined);
    assert.equal(donor.startInput(second.receipt).started, true);
    assert.deepEqual(donor.completeInput(second.receipt).removedUpdateIds, [2]);

    const third = donor.acquireInput({ updateId: 3, recipientBindingKey: "workspace:owner" });
    const thirdOffer = donor.offerInputHandoff({ receipt: third.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    const recoveryRequest = { receipt: third.receipt, recoveryOwner: recipientOwner };
    liveness = "alive";
    assert.equal(recovery.recoverReadyInput(recoveryRequest).status, "owner-alive");
    liveness = "unverifiable";
    assert.equal(recovery.recoverReadyInput(recoveryRequest).status, "owner-unverifiable");
    liveness = "dead";
    assert.equal(recovery.recoverReadyInput(recoveryRequest).status, "recovered");
    assert.equal(livenessCalls, 3);
    assert.equal(donor.read().entries[0]!.inputClaim, undefined);
    assert.throws(() => recovery.acceptInputHandoff({ source: thirdOffer.source, recipientOwner,
      handoffId: thirdOffer.handoff.handoffId }), (error) => isJournalError(error, "conflict"));
    const reacquired = donor.acquireInput({ updateId: 3, recipientBindingKey: "workspace:owner" });
    assert.equal(donor.startInput(reacquired.receipt).started, true);
    assert.deepEqual(donor.completeInput(reacquired.receipt).removedUpdateIds, [3]);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody serializes duplicate accept and accept/dead-recovery across processes", async context => {
  await withInputCustodyFixture(context, async ({ options, dir, path, ledger }) => {
    const donor = createTelegramInputJournalStore(options);
    donor.appendBatch([{ update_id: 1 }, { update_id: 2 }], 2);
    const recipientRuntime = { instanceId: "recipient-race", processId: process.pid + 5000,
      processBirthId: `${process.pid + 5000}:recipient-race` };
    const recipientOwner = { ...recipientRuntime, sessionGeneration: 2 };
    const recoveryOwner = { instanceId: "recovery-race", processId: process.pid + 5001,
      processBirthId: `${process.pid + 5001}:recovery-race`, sessionGeneration: 1 };
    const recipient = createTelegramInputJournalStore({ ...options, queueRuntimeIdentity: recipientRuntime,
      getInputContext: () => ({ owner: recipientOwner, recipientBindingKey: "workspace:owner" }) });
    const requestPath = join(dir, "handoff-worker-request.json");
    const output = async (worker: number) => JSON.parse(
      await readFile(join(dir, `handoff-worker-${worker}.json`), "utf8"),
    ) as { kind: string; duplicate?: boolean; status?: string;
      receipt?: ReturnType<typeof donor.acquireInput>["receipt"] };

    const first = donor.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    const firstOffer = donor.offerInputHandoff({ receipt: first.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    const firstRequest = { acceptance: { source: firstOffer.source, recipientOwner,
      handoffId: firstOffer.handoff.handoffId },
    recovery: { receipt: first.receipt, recoveryOwner }, recipientBindingKey: "workspace:owner",
    recipientOwner, recoveryOwner };
    await writeFile(requestPath, JSON.stringify(firstRequest));
    await Promise.all([runJournalWorker(path, 1, 1, "input-handoff-accept"),
      runJournalWorker(path, 2, 1, "input-handoff-accept")]);
    const duplicateResults = await Promise.all([output(1), output(2)]);
    assert.deepEqual(duplicateResults.map(result => result.kind), ["accepted", "accepted"]);
    assert.deepEqual(duplicateResults.map(result => result.duplicate).sort(), [false, true]);
    assert.deepEqual(duplicateResults[0]!.receipt, duplicateResults[1]!.receipt);
    const acceptedReceipt = duplicateResults[0]!.receipt!;
    assert.equal(recipient.startInput(acceptedReceipt).started, true);
    assert.deepEqual(recipient.completeInput(acceptedReceipt).removedUpdateIds, [1]);

    const second = donor.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
    const secondOffer = donor.offerInputHandoff({ receipt: second.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() });
    const secondRequest = { acceptance: { source: secondOffer.source, recipientOwner,
      handoffId: secondOffer.handoff.handoffId },
    recovery: { receipt: second.receipt, recoveryOwner }, recipientBindingKey: "workspace:owner",
    recipientOwner, recoveryOwner };
    await writeFile(requestPath, JSON.stringify(secondRequest));
    await Promise.all([runJournalWorker(path, 3, 2, "input-handoff-accept"),
      runJournalWorker(path, 4, 2, "input-handoff-recover")]);
    const raced = await Promise.all([output(3), output(4)]);
    const accepted = raced.find(result => result.kind === "accepted");
    const recovered = raced.find(result => result.kind === "recovered" && result.status === "recovered");
    assert.equal(Number(Boolean(accepted)) + Number(Boolean(recovered)), 1);
    if (accepted?.receipt) {
      assert.equal(recipient.startInput(accepted.receipt).started, true);
      assert.deepEqual(recipient.completeInput(accepted.receipt).removedUpdateIds, [2]);
    } else {
      assert.equal(donor.read().entries[0]!.inputClaim, undefined);
      const reacquired = donor.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
      assert.equal(donor.startInput(reacquired.receipt).started, true);
      assert.deepEqual(donor.completeInput(reacquired.receipt).removedUpdateIds, [2]);
    }
    assert.deepEqual(donor.read().entries, []);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody offer reserves dead-donor recovery through complete cleanup refusal", async context => {
  await withInputCustodyFixture(context, async ({ options, dir, ledger }) => {
    const path = join(dir, "handoff-headroom.json");
    const initial = createTelegramInputJournalStore({ ...options, path });
    initial.appendBatch([{ update_id: 1 }], 1);
    const donorClaim = initial.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    const recipientRuntime = { instanceId: "recipient", processId: process.pid + 4000,
      processBirthId: `${process.pid + 4000}:recipient` };
    const recipientOwner = { ...recipientRuntime, sessionGeneration: 2 };
    const handoff = { receipt: donorClaim.receipt, recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() };
    const before = await readFile(path, "utf8");
    const insufficient = createTelegramInputJournalStore({ ...options, path,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 5 } } });
    assert.throws(() => insufficient.offerInputHandoff(handoff), (error) => isJournalError(error, "capacity"));
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(existsSync(`${path}.segments`), false);
    const donor = createTelegramInputJournalStore({ ...options, path,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 6 } } });
    const recipient = createTelegramInputJournalStore({ ...options, path, queueRuntimeIdentity: recipientRuntime,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 6 } },
      getInputContext: () => ({ owner: recipientOwner, recipientBindingKey: "workspace:owner" }),
      getQueueProcessLiveness: () => "dead" });
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = ((target: fs.PathLike) => {
      if (String(target).startsWith(`${path}.segments/`)) throw new Error("synthetic retained handoff segment");
      return originalUnlink(target);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try {
      donor.offerInputHandoff(handoff);
      assert.equal(recipient.recoverReadyInput({ receipt: donorClaim.receipt,
        recoveryOwner: recipientOwner }).status, "recovered");
      const reacquired = recipient.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
      assert.equal(recipient.startInput(reacquired.receipt).started, true);
      assert.deepEqual(recipient.completeInput(reacquired.receipt).removedUpdateIds, [1]);
    } finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
    assert.deepEqual(recipient.read().entries, []);
    assert.equal((await readdir(`${path}.segments`)).length, 5);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody atomically replaces exact running claims with one grouped Pi queue receipt", async context => {
  await withInputCustodyFixture(context, async ({ options, setOwner, ledger }) => {
    const store = createTelegramInputJournalStore(options);
    store.appendBatch([{ update_id: 1, message: { text: "one" } },
      { update_id: 2, message: { text: "two" } }], 2);
    const first = store.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner",
      executionUpdate: { update_id: 1, message: { text: "routed one", message_thread_id: 9 } } });
    const second = store.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
    assert.equal(store.startInput(first.receipt).started, true);
    assert.equal(store.startInput(second.receipt).started, true);
    const request = { queueKind: "prompt" as const, receiptId: "grouped-prompt",
      receipts: [second.receipt, first.receipt] };
    const queued = store.queueInputs(request);
    assert.equal(queued.queued, true);
    assert.deepEqual(queued.queueReceipt.sourceUpdateIds, [1, 2]);
    assert.equal(queued.queueReceipt.queueOwner.instanceId, options.queueRuntimeIdentity.instanceId);
    assert.notEqual(queued.queueReceipt.queueOwner.acquisitionId, first.receipt.owner.acquisitionId);
    const snapshot = store.read();
    assert.deepEqual(snapshot.entries.map(entry => entry.state), ["queued", "queued"]);
    assert.deepEqual(snapshot.entries.map(entry => entry.inputClaim), [undefined, undefined]);
    assert.deepEqual(snapshot.entries.map(entry => entry.queueOwner),
      [queued.queueReceipt.queueOwner, queued.queueReceipt.queueOwner]);
    assert.deepEqual(snapshot.entries[0]!.inputProvenance, {
      owner: first.receipt.owner, recipientBindingKey: "workspace:owner",
      executionUpdate: { update_id: 1, message: { text: "routed one", message_thread_id: 9 } },
    });
    assert.deepEqual(snapshot.entries[1]!.inputProvenance,
      { owner: second.receipt.owner, recipientBindingKey: "workspace:owner" });
    const duplicate = store.queueInputs(request);
    assert.equal(duplicate.queued, false);
    assert.deepEqual(duplicate.queueReceipt, queued.queueReceipt);
    const retained = store.read();
    for (const receipt of [first.receipt, second.receipt]) {
      assert.throws(() => store.startInput(receipt), (error) => isJournalError(error, "conflict"));
      assert.throws(() => store.completeInput(receipt), (error) => isJournalError(error, "conflict"));
      assert.throws(() => store.releaseInput(receipt), (error) => isJournalError(error, "conflict"));
    }
    assert.throws(() => store.queueInputs({ ...request, queueKind: "control" }),
      (error) => isJournalError(error, "conflict"));
    assert.throws(() => store.queueInputs({ ...request, receipts: [first.receipt] }),
      (error) => isJournalError(error, "conflict"));
    assert.throws(() => store.queueInputs({ ...request, receipts: [first.receipt,
      { ...second.receipt, owner: { ...second.receipt.owner, acquisitionId: "stale" } }] }),
    (error) => isJournalError(error, "conflict"));
    assert.deepEqual(store.read(), retained);
    setOwner(undefined);
    assert.deepEqual(store.completeQueued([queued.queueReceipt]).removedUpdateIds, [1, 2]);
    assert.deepEqual(store.appendBatch([{ update_id: 1 }, { update_id: 2 }], 2).addedUpdateIds, []);
    assert.deepEqual(store.read().entries, []);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Input custody grouped queue transition reserves commit-unknown completion with cleanup residue", async context => {
  await withInputCustodyFixture(context, async ({ options, dir, setHook, ledger }) => {
    const path = join(dir, "queue-headroom.json");
    const initial = createTelegramInputJournalStore({ ...options, path });
    initial.appendBatch([{ update_id: 1 }, { update_id: 2 }], 2);
    const first = initial.acquireInput({ updateId: 1, recipientBindingKey: "workspace:owner" });
    const second = initial.acquireInput({ updateId: 2, recipientBindingKey: "workspace:owner" });
    assert.equal(initial.startInput(first.receipt).started, true);
    assert.equal(initial.startInput(second.receipt).started, true);
    const request = { queueKind: "prompt" as const, receiptId: "bounded-group",
      receipts: [first.receipt, second.receipt] };
    const before = await readFile(path, "utf8");
    const insufficient = createTelegramInputJournalStore({ ...options, path,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 2 } } });
    assert.throws(() => insufficient.queueInputs(request), (error) => isJournalError(error, "capacity"));
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(existsSync(`${path}.segments`), false);
    const bounded = createTelegramInputJournalStore({ ...options, path,
      sourceAccess: { ...options.sourceAccess, limits: { ...options.sourceAccess.limits, maxFiles: 3 } } });
    let boundaries = 0;
    setHook(boundary => {
      boundaries += 1;
      if (boundaries === 3 && boundary === "before-write") throw new Error("queue snapshot commit unknown");
    });
    assert.throws(() => bounded.queueInputs(request), (error) => isJournalError(error, "io"));
    setHook(undefined);
    const duplicate = bounded.queueInputs(request);
    assert.equal(duplicate.queued, false);
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = ((target: fs.PathLike) => {
      if (String(target).startsWith(`${path}.segments/`)) throw new Error("synthetic retained queue segment");
      return originalUnlink(target);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try {
      assert.deepEqual(bounded.completeQueued([duplicate.queueReceipt]).removedUpdateIds, [1, 2]);
    } finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
    assert.deepEqual(bounded.read().entries, []);
    assert.equal((await readdir(`${path}.segments`)).length, 2);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Custody v3 decodes input claims without granting legacy consumers access", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-custody-codec-")));
  const path = join(dir, "inbox.work.json");
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-custody-codec" });
  const owner = { instanceId: "receiver", processId: 42, processBirthId: "birth-42",
    sessionGeneration: 1, acquisitionId: "claim-42", acquiredAtMs: 100 };
  const entry = { updateId: 42, update: { update_id: 42, message: { text: "original" } },
    preApprovalExcluded: false, admittedAtMs: 90, state: "pending",
    inputClaim: { phase: "ready", owner, recipientBindingKey: "workspace:receiver",
      executionUpdate: { update_id: 42, message: { text: "routed", message_thread_id: 9 } } } };
  const file = { version: 3, profile: "work", botIdentity, acceptedThroughUpdateId: 42, entries: [entry] };
  const input = { directory: dir, path, profile: "work", botIdentity, version: 3 as const,
    limits: { maxFiles: 10, maxBytes: 100_000, maxEntries: 10, maxWork: 100 } };
  const validHandoff = { handoffId: `input-handoff-${"a".repeat(32)}`, offeredAtMs: 100,
    recipientOwner: { instanceId: "recipient", processId: 43, processBirthId: "birth-43", sessionGeneration: 2 } };
  try {
    await writeFile(path, JSON.stringify(file));
    if (assertUnsupportedStrictInspection(input, context, () => readTelegramUpdateJournalSource(input))) return;
    for (const phase of ["ready", "running"] as const) {
      file.entries[0]!.inputClaim.phase = phase;
      await writeFile(path, JSON.stringify(file));
      const before = await readFile(path);
      const result = readTelegramUpdateJournalSource(input);
      assert.equal(result.kind, "present");
      if (result.kind !== "present") assert.fail("Expected owned input evidence");
      assert.deepEqual(result.file, file);
      assert.deepEqual(inspectTelegramUpdateJournalFamily(input), result);
      assert.throws(() => readTelegramUpdateJournalSource({ ...input,
        limits: { ...input.limits, maxBytes: before.length - 1 } }), (error) => isJournalError(error, "capacity"));
      assert.throws(() => readTelegramUpdateJournalSource({ ...input, version: 2 }),
        (error) => isJournalError(error, "unsupported-version"));
      assert.equal(createTelegramUpdateJournalReceiptScope({ profileName: result.file.profile,
        botIdentity: result.file.botIdentity }), createTelegramUpdateJournalReceiptScope({ profileName: "work", botIdentity }));
      for (const paired of [false, true]) {
        const store = createTelegramUpdateJournalStore({ path, profileName: "work", botIdentity,
          ...(paired ? { withPairingAdmission: <T>(publish: (excluded: boolean) => T) => publish(false) } : {}) });
        assert.throws(() => store.read(), (error) => isJournalError(error, "unsupported-version"));
        assert.throws(() => store.removeCompleted([42]), (error) => isJournalError(error, "unsupported-version"));
      }
      assert.deepEqual(await readFile(path), before);
      assert.deepEqual(await readdir(dir), ["inbox.work.json"]);
    }
    const offeredFile = structuredClone(file);
    offeredFile.entries[0]!.inputClaim.phase = "ready";
    Reflect.set(offeredFile.entries[0]!.inputClaim, "handoff", validHandoff);
    await writeFile(path, JSON.stringify(offeredFile));
    const offeredEvidence = readTelegramUpdateJournalSource(input);
    assert.equal(offeredEvidence.kind, "present");
    if (offeredEvidence.kind === "present") {
      assert.deepEqual(offeredEvidence.file.entries[0]!.inputClaim?.handoff, validHandoff);
    }
    const validProvenance = { owner, recipientBindingKey: "workspace:receiver",
      executionUpdate: { update_id: 42, message: { text: "routed", message_thread_id: 9 } } };
    const queuedFile = structuredClone(file);
    const queuedEntry = queuedFile.entries[0]!;
    Reflect.deleteProperty(queuedEntry, "inputClaim");
    Object.assign(queuedEntry, { state: "queued", queueKind: "prompt", queueReceiptId: "receipt-42",
      queueOwner: { ...owner, acquisitionId: "queue-42", acquiredAtMs: 101 },
      inputProvenance: validProvenance });
    await writeFile(path, JSON.stringify(queuedFile));
    const queuedEvidence = readTelegramUpdateJournalSource(input);
    assert.equal(queuedEvidence.kind, "present");
    if (queuedEvidence.kind === "present") {
      assert.deepEqual(queuedEvidence.file.entries[0]!.inputProvenance, validProvenance);
      assert.equal(queuedEvidence.file.entries[0]!.inputClaim, undefined);
    }
    const invalid: Array<[string, (value: typeof file) => void]> = [
      ["missing cursor", value => Reflect.deleteProperty(value, "acceptedThroughUpdateId")],
      ["missing veto", value => Reflect.deleteProperty(value.entries[0]!, "preApprovalExcluded")],
      ["excluded claim", value => value.entries[0]!.preApprovalExcluded = true],
      ["missing owner", value => Reflect.deleteProperty(value.entries[0]!.inputClaim, "owner")],
      ["invalid birth", value => value.entries[0].inputClaim.owner.processBirthId = ""],
      ["unsafe generation", value => value.entries[0].inputClaim.owner.sessionGeneration = Number.MAX_SAFE_INTEGER + 1],
      ["unknown owner field", value => Reflect.set(value.entries[0]!.inputClaim.owner, "role", "leader")],
      ["invalid accepted handoff id", value => Reflect.set(
        value.entries[0]!.inputClaim.owner, "handoffId", "queue-handoff")],
      ["missing binding", value => Reflect.deleteProperty(value.entries[0]!.inputClaim, "recipientBindingKey")],
      ["empty binding", value => value.entries[0]!.inputClaim.recipientBindingKey = " "],
      ["oversized binding", value => value.entries[0]!.inputClaim.recipientBindingKey = "x".repeat(257)],
      ["unknown phase", value => value.entries[0]!.inputClaim.phase = "offered"],
      ["running handoff", value => Reflect.set(value.entries[0]!.inputClaim, "handoff", validHandoff)],
      ["same-owner handoff", value => {
        value.entries[0]!.inputClaim.phase = "ready";
        Reflect.set(value.entries[0]!.inputClaim, "handoff", { ...validHandoff,
          recipientOwner: { instanceId: owner.instanceId, processId: owner.processId,
            processBirthId: owner.processBirthId, sessionGeneration: owner.sessionGeneration } });
      }],
      ["invalid handoff recipient", value => {
        value.entries[0]!.inputClaim.phase = "ready";
        Reflect.set(value.entries[0]!.inputClaim, "handoff", { ...validHandoff,
          recipientOwner: { ...validHandoff.recipientOwner, sessionGeneration: 0 } });
      }],
      ["invalid offered handoff id", value => {
        value.entries[0]!.inputClaim.phase = "ready";
        Reflect.set(value.entries[0]!.inputClaim, "handoff", { ...validHandoff, handoffId: "queue-handoff" });
      }],
      ["unknown handoff field", value => {
        value.entries[0]!.inputClaim.phase = "ready";
        Reflect.set(value.entries[0]!.inputClaim, "handoff", { ...validHandoff, accepted: false });
      }],
      ["running while retrying", value => {
        value.entries[0]!.state = "retry-wait";
        Reflect.set(value.entries[0]!, "failure", { attemptCount: 1, failedAtMs: 101, failureClass: "test", summary: "test" });
        Reflect.set(value.entries[0]!, "nextRetryAtMs", 102);
      }],
      ["dual raw/queue authority", value => {
        value.entries[0]!.state = "queued";
        Object.assign(value.entries[0]!, { queueKind: "prompt", queueReceiptId: "receipt-42", queueOwner: owner });
      }],
      ["unknown claim field", value => Reflect.set(value.entries[0]!.inputClaim, "ready", true)],
      ["projection id mismatch", value => value.entries[0]!.inputClaim.executionUpdate.update_id = 43],
      ["provenance with raw authority", value => Reflect.set(
        value.entries[0]!, "inputProvenance", validProvenance)],
      ["provenance projection id mismatch", value => {
        Reflect.deleteProperty(value.entries[0]!, "inputClaim");
        Object.assign(value.entries[0]!, { state: "queued", queueKind: "prompt", queueReceiptId: "receipt-42",
          queueOwner: { ...owner, acquisitionId: "queue-42", acquiredAtMs: 101 },
          inputProvenance: { ...validProvenance, executionUpdate: { update_id: 43 } } });
      }],
      ["unknown provenance field", value => {
        Reflect.deleteProperty(value.entries[0]!, "inputClaim");
        Object.assign(value.entries[0]!, { state: "queued", queueKind: "prompt", queueReceiptId: "receipt-42",
          queueOwner: { ...owner, acquisitionId: "queue-42", acquiredAtMs: 101 },
          inputProvenance: { ...validProvenance, authority: true } });
      }],
      ["queue metadata", value => Reflect.set(value.entries[0]!, "queueOwner", owner)],
      ["v1 claim", value => { value.version = 1; Reflect.deleteProperty(value.entries[0]!, "preApprovalExcluded"); }],
      ["v2 claim", value => value.version = 2],
    ];
    for (const [label, mutate] of invalid) {
      const value = structuredClone(file);
      mutate(value);
      await writeFile(path, JSON.stringify(value));
      const before = await readFile(path);
      assert.throws(() => inspectTelegramUpdateJournalFamily(input), TelegramUpdateJournalError, label);
      assert.deepEqual(await readFile(path), before, label);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Custody v3 retained segments validate claims and preserve exclusion/cursor replay barriers", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-custody-segments-")));
  const path = join(dir, "inbox.work.json");
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-custody-segments" });
  const entry = { updateId: 42, update: { update_id: 42 }, preApprovalExcluded: false,
    admittedAtMs: 90, state: "pending", inputClaim: { phase: "ready", recipientBindingKey: "workspace:receiver",
      owner: { instanceId: "receiver", processId: 42, processBirthId: "birth-42", sessionGeneration: 1,
        acquisitionId: "claim-42", acquiredAtMs: 100 } } };
  const base = { version: 3, profile: "work", botIdentity, acceptedThroughUpdateId: 42 };
  const input = { directory: dir, path, profile: "work", botIdentity, version: 3 as const,
    limits: { maxFiles: 10, maxBytes: 100_000, maxEntries: 10, maxWork: 100 } };
  const segment = { ...base, revision: 1, previousRevision: 0, upsertedEntries: [entry], removedUpdateIds: [] };
  try {
    await writeFile(path, JSON.stringify({ ...base, entries: [entry] }));
    if (assertUnsupportedStrictInspection(input, context)) return;
    await mkdir(`${path}.segments`);
    const segmentPath = join(`${path}.segments`, "0000000000000001.json");
    await writeFile(segmentPath, JSON.stringify(segment));
    const read = () => readTelegramUpdateJournalSource(input);
    assert.equal(read().kind, "present");
    const running = structuredClone(segment);
    running.upsertedEntries[0]!.inputClaim.phase = "running";
    await writeFile(segmentPath, JSON.stringify(running));
    const decoded = read();
    assert.equal(decoded.kind, "present");
    if (decoded.kind === "present") assert.equal(decoded.file.entries[0]!.inputClaim?.phase, "running");
    for (const change of ["malformed", "veto", "cursor", "resurrect"] as const) {
      const bad = structuredClone(segment);
      if (change === "malformed") bad.upsertedEntries[0]!.inputClaim.owner.acquisitionId = "";
      if (change === "veto") { bad.upsertedEntries[0]!.preApprovalExcluded = true; Reflect.deleteProperty(bad.upsertedEntries[0]!, "inputClaim"); }
      if (change === "cursor") Reflect.deleteProperty(bad, "acceptedThroughUpdateId");
      if (change === "resurrect") await writeFile(path, JSON.stringify({ ...base, entries: [] }));
      await writeFile(segmentPath, JSON.stringify(bad));
      const before = await readFile(segmentPath);
      assert.throws(read, TelegramUpdateJournalError, change);
      assert.deepEqual(await readFile(segmentPath), before);
    }
    // Redundant history is still decoded, not trusted merely because a snapshot covers it.
    await writeFile(path, JSON.stringify({ ...base, revision: 1, entries: [entry] }));
    const malformed = structuredClone(segment);
    malformed.upsertedEntries[0]!.inputClaim.phase = "unknown";
    await writeFile(segmentPath, JSON.stringify(malformed));
    assert.throws(read, TelegramUpdateJournalError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Strict family inspection preserves evidence and rejects uncertain families without writes", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-strict-journal-")));
  const path = join(dir, "journal.json");
  const segmentDir = `${path}.segments`;
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-strict" });
  const limits = { maxFiles: 20, maxBytes: 100_000, maxEntries: 10, maxWork: 100 };
  const input = { directory: dir, path, profile: "default", botIdentity, limits };
  const snapshot = { version: 1, revision: 1, profile: "default", botIdentity, acceptedThroughUpdateId: 1, entries: [] };
  const segment = { version: 1, revision: 2, previousRevision: 1, profile: "default", botIdentity,
    acceptedThroughUpdateId: 2, upsertedEntries: [], removedUpdateIds: [] };
  const segmentPath = join(segmentDir, "0000000000000002.json");
  const tree = async (): Promise<unknown> => {
    const walk = async (directory: string): Promise<unknown[]> => Promise.all((await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
        const target = join(directory, entry.name);
        return entry.isSymbolicLink() ? [entry.name, await readlink(target)] :
          [entry.name, entry.isDirectory() ? await walk(target) : (await readFile(target)).toString("hex"), (await stat(target)).mode];
      }));
    return walk(dir);
  };
  const reject = async (override = {}) => {
    const before = await tree();
    assert.throws(() => inspectTelegramUpdateJournalFamily({ ...input, ...override }), TelegramUpdateJournalError);
    assert.deepEqual(await tree(), before);
  };
  try {
    if (assertUnsupportedStrictInspection(input, context)) {
      assert.deepEqual(await tree(), []);
      return;
    }
    assert.deepEqual(inspectTelegramUpdateJournalFamily(input), { kind: "absent" });
    await writeFile(path, JSON.stringify(snapshot));
    await mkdir(segmentDir);
    await writeFile(segmentPath, JSON.stringify(segment));
    const before = await tree();
    const result = inspectTelegramUpdateJournalFamily(input);
    assert.equal(result.kind, "present");
    if (result.kind === "present") {
      assert.deepEqual(result.file, { ...snapshot, revision: 2, acceptedThroughUpdateId: 2 });
      assert.equal(result.accounting.files, 2);
    }
    assert.deepEqual(await tree(), before);
    await reject({ profile: "foreign" });
    await reject({ botIdentity: { ...botIdentity, tokenSha256: "a".repeat(64) } });
    await reject({ path: join(dir, "..", "escaped.json") });
    await reject({ limits: { ...limits, maxFiles: 1 } });
    await reject({ limits: { ...limits, maxBytes: Buffer.byteLength(JSON.stringify(snapshot)) } });
    await reject({ limits: { ...limits, maxWork: 0 } });
    for (const change of [
      { version: 99 }, { version: 2 }, { previousRevision: 0 }, { revision: 3 },
      { operatorDispositions: Array(2).fill({ failureId: "f", updateId: 1, action: "discard", committedAtMs: 1,
        attemptCount: 1, failureClass: "synthetic", terminalAtMs: 1, terminalReason: "synthetic" }) },
    ]) {
      await writeFile(segmentPath, JSON.stringify({ ...segment, ...change }));
      await reject();
    }
    await writeFile(path, JSON.stringify({ ...snapshot, revision: 2 }));
    for (const version of [99, 2]) {
      await writeFile(segmentPath, JSON.stringify({ ...segment, version }));
      await reject();
    }
    await writeFile(path, JSON.stringify(snapshot));
    await rm(segmentPath);
    const gapPath = join(segmentDir, "0000000000000003.json");
    await writeFile(gapPath, JSON.stringify({ ...segment, revision: 3, previousRevision: 2 }));
    await reject();
    await rm(gapPath);
    await writeFile(segmentPath, JSON.stringify({ ...segment, botIdentity: { ...botIdentity, botId: 1 } }));
    await writeFile(join(segmentDir, "0000000000000001.json"), JSON.stringify({ ...segment, revision: 1, previousRevision: 0, botIdentity: { ...botIdentity, botId: 2 } }));
    await reject();
    await rm(join(segmentDir, "0000000000000001.json"));
    await writeFile(segmentPath, JSON.stringify(segment));
    await rm(path);
    await reject();
    await mkdir(path);
    assert.throws(() => inspectTelegramUpdateJournalFamily(input));
    await rm(path, { recursive: true });
    await symlink(segmentPath, path);
    await reject();
    await rm(path);
    await symlink(segmentDir, join(dir, "linked-directory"));
    await reject({ path: join(dir, "linked-directory", "journal.json") });
    await reject({ directory: join(dir, "linked-directory"), path: join(dir, "linked-directory", "journal.json") });
    await rm(join(dir, "linked-directory"));
    const utf8Parts = JSON.stringify({ ...snapshot, entries: [{ updateId: 1, admittedAtMs: 1,
      state: "pending", update: { update_id: 1, text: "UTF8_MARKER" } }] }).split("UTF8_MARKER");
    await writeFile(path, Buffer.concat([Buffer.from(utf8Parts[0]!), Buffer.from([0xff]), Buffer.from(utf8Parts[1]!)]));
    await reject();
    await writeFile(path, JSON.stringify(snapshot));
    await rm(segmentPath);
    await symlink(path, segmentPath);
    await reject();
    await rm(segmentPath);
    await writeFile(segmentPath, JSON.stringify(segment));
    // Deterministically inject a change at the actual opened-handle read boundary.
    const original = fs.readSync;
    let changed = false;
    fs.readSync = ((...args: Parameters<typeof readSync>) => {
      const count = Reflect.apply(original, fs, args) as number;
      if (!changed) { changed = true; writeFileSync(path, JSON.stringify({ ...snapshot, revision: 9 })); }
      return count;
    }) as typeof readSync;
    syncBuiltinESMExports();
    try { assert.throws(() => inspectTelegramUpdateJournalFamily(input), TelegramUpdateJournalError); }
    finally { fs.readSync = original; syncBuiltinESMExports(); }
    assert.equal(changed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Live source reader refuses unavailable open capabilities (synthetic, not native Windows evidence)", () => {
  const syntheticDirectory = resolve(tmpdir(), "pi-telegram-synthetic-journal");
  const syntheticPath = join(syntheticDirectory, "journal.json");
  for (const flag of ["O_NOFOLLOW", "O_NONBLOCK"]) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { registerHooks } from 'node:module';
      import assert from 'node:assert/strict';
      registerHooks({ load(url, context, next) {
        const loaded = next(url, context);
        if (url === ${JSON.stringify(new URL("../lib/journal.ts", import.meta.url).href)}) {
          return { ...loaded, source: String(loaded.source).replace('  constants,', '  constants as nativeConstants,') +
            '\\nconst constants = { ...nativeConstants, ${flag}: 0 };\\n' };
        }
        return loaded;
      } });
      const { readTelegramUpdateJournalSource } = await import(${JSON.stringify(new URL("../lib/journal.ts", import.meta.url).href)});
      assert.throws(() => readTelegramUpdateJournalSource({ directory: ${JSON.stringify(syntheticDirectory)}, path: ${JSON.stringify(syntheticPath)},
        profile: 'default', botIdentity: { tokenSha256: 'a'.repeat(64) }, version: 1,
        limits: { maxFiles: 1, maxBytes: 1, maxEntries: 1, maxWork: 1 } }), /platform lacks no-follow nonblocking open evidence/);
    `], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Live source reader preserves selected schema, exact identity, scope and rejection bytes", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-live-source-")));
  const path = join(dir, "journal.json");
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-live" });
  const input = { directory: dir, path, profile: "default", botIdentity,
    limits: { maxFiles: 10, maxBytes: 100_000, maxEntries: 10, maxWork: 100 }, version: 1 as 1 | 2 };
  const inspect = () => readTelegramUpdateJournalSource(input);
  const reject = (override = {}) => {
    const before = fs.readFileSync(path);
    assert.throws(() => readTelegramUpdateJournalSource({ ...input, ...override }), TelegramUpdateJournalError);
    assert.deepEqual(fs.readFileSync(path), before);
  };
  try {
    if (assertUnsupportedStrictInspection(input, context, inspect)) return;
    assert.deepEqual(inspect(), { kind: "absent" });
    for (const version of [1, 2] as const) {
      input.version = version;
      const raw = { version, profile: "default", botIdentity, acceptedThroughUpdateId: 1,
        entries: [{ updateId: 1, update: { update_id: 1 }, admittedAtMs: 1, state: "pending",
          ...(version === 2 ? { preApprovalExcluded: false } : {}) }] };
      await writeFile(path, JSON.stringify(raw));
      assert.deepEqual(inspect(), inspectTelegramUpdateJournalFamily(input));
      reject({ version: version === 1 ? 2 : 1 });
      reject({ version: undefined });
      reject({ botIdentity: { ...botIdentity, botId: 7 } });
      for (const limits of [{ ...input.limits, maxBytes: 1 }, { ...input.limits, maxEntries: 0 },
        { ...input.limits, maxWork: 0 }, { ...input.limits, maxFiles: 0 }]) reject({ limits });
      await writeFile(path, JSON.stringify({ ...raw, botIdentity: { ...botIdentity, botId: 7 } }));
      reject();
      const known = { ...botIdentity, botId: 7 };
      assert.equal(readTelegramUpdateJournalSource({ ...input, botIdentity: known }).kind, "present");
      reject({ botIdentity: { ...known, tokenSha256: "a".repeat(64) } });
      reject({ botIdentity: { ...known, botId: 8 } });
      for (const malformed of ["{", Buffer.from([0xff]), JSON.stringify({ ...raw, entries: [null] })]) {
        await writeFile(path, malformed);
        reject();
      }
    }
    await rm(path);
    await mkdir(`${path}.segments`);
    assert.throws(inspect, TelegramUpdateJournalError);
    assert.throws(() => readTelegramUpdateJournalSource({ ...input, directory: join(dir, "missing"),
      path: join(dir, "missing", "journal.json") }), TelegramUpdateJournalError);
    assert.throws(() => readTelegramUpdateJournalSource({ ...input, path: join(dir, "missing", "journal.json") }), TelegramUpdateJournalError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Live ancestor endpoints tolerate sibling churn while full inspection and source mutations refuse", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-live-endpoints-")));
  const root = join(dir, "root");
  const parent = join(root, "nested");
  const path = join(parent, "journal.json");
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-endpoints" });
  const input = { directory: root, path, profile: "default", botIdentity, version: 1 as 1 | 2,
    limits: { maxFiles: 10, maxBytes: 100_000, maxEntries: 10, maxWork: 100 } };
  const snapshot = JSON.stringify({ version: 1, revision: 1, profile: "default", botIdentity, entries: [] });
  const segmentDir = `${path}.segments`;
  const segmentPath = join(segmentDir, "0000000000000002.json");
  const segment = JSON.stringify({ version: 1, revision: 2, previousRevision: 1, profile: "default", botIdentity,
    upsertedEntries: [], removedUpdateIds: [] });
  const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
  const probe = (mutate: () => void, live: boolean | "store", accepted: boolean, readNumber = 1) => {
    const original = fs.readSync;
    let changed = false;
    let reads = 0;
    fs.readSync = ((...args: Parameters<typeof readSync>) => {
      const count = Reflect.apply(original, fs, args) as number;
      if (++reads === readNumber) { changed = true; mutate(); }
      return count;
    }) as typeof readSync;
    syncBuiltinESMExports();
    try {
      const read = () => {
        if (live !== "store") return live ? readTelegramUpdateJournalSource(input) : inspectTelegramUpdateJournalFamily(input);
        const result = createTelegramUpdateJournalStore({ path, botIdentity,
          sourceAccess: { directory: root, limits: input.limits }, withSourceSerialization: config.withSourceSerialization }).read();
        return { kind: result.exists ? "present" : "absent" };
      };
      if (accepted) assert.equal(read().kind, "present");
      else assert.throws(read, TelegramUpdateJournalError);
      assert.equal(changed, true);
    } finally { fs.readSync = original; syncBuiltinESMExports(); }
  };
  try {
    await mkdir(parent, { recursive: true });
    if (assertUnsupportedStrictInspection(input, context, () => readTelegramUpdateJournalSource(input))) return;
    const reset = () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(path, snapshot);
      fs.mkdirSync(segmentDir);
      fs.writeFileSync(segmentPath, segment);
    };
    for (const target of [root, parent]) {
      for (const live of [false, true, "store"] as const) {
        reset();
        probe(() => {
          const sibling = join(target, "sibling");
          fs.mkdirSync(sibling);
          fs.renameSync(sibling, `${sibling}-renamed`);
          fs.rmdirSync(`${sibling}-renamed`);
          // Ensure an observable full-inspector timestamp witness on coarse filesystems.
          fs.utimesSync(target, 1, 1);
        }, live, live !== false);
      }
      for (const change of ["mode", "replacement", "type", "alias"] as const) {
        reset();
        probe(() => {
          if (change === "mode") fs.chmodSync(target, 0o500);
          else {
            const moved = join(dir, "moved");
            fs.renameSync(target, moved);
            if (change === "replacement") fs.mkdirSync(target);
            if (change === "type") fs.writeFileSync(target, "not a directory");
            if (change === "alias") fs.symlinkSync(moved, target);
          }
        }, true, false);
        if (change === "mode") fs.chmodSync(target, 0o700);
        fs.rmSync(join(dir, "moved"), { recursive: true, force: true });
      }
    }
    for (const mutate of [
      () => fs.writeFileSync(path, `${snapshot} `),
      () => fs.writeFileSync(join(segmentDir, "0000000000000003.json"), segment),
      () => fs.utimesSync(segmentDir, 1, 1),
    ]) {
      for (const live of [true, "store"] as const) { reset(); probe(mutate, live, false); }
    }
    reset();
    probe(() => fs.writeFileSync(segmentPath, `${segment} `), true, false, 3);
    reset();
    probe(() => { input.version = 2; input.profile = "foreign"; input.botIdentity.tokenSha256 = "a".repeat(64);
      input.limits.maxBytes = 1; }, true, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Strict inspection bounds raw, reconstructed and repeated work and preserves v1/v2 codecs", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-strict-budget-")));
  const path = join(dir, "journal.json");
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-budget" });
  const limits = { maxFiles: 10, maxBytes: 100_000, maxEntries: 10, maxWork: 100 };
  const input = { directory: dir, path, profile: "default", botIdentity, limits };
  const entry = { updateId: 1, update: { update_id: 1 }, admittedAtMs: 1, state: "pending" };
  try {
    if (assertUnsupportedStrictInspection(input, context)) {
      assert.deepEqual(await readdir(dir), []);
      return;
    }
    await mkdir(`${path}.segments`);
    for (const version of [1, 2] as const) {
      const entries = [{ ...entry, ...(version === 2 ? { preApprovalExcluded: false } : {}) }];
      const snapshot = { version, revision: 1, profile: "default", botIdentity, acceptedThroughUpdateId: 1, entries };
      const segment = { version, revision: 2, previousRevision: 1, profile: "default", botIdentity,
        acceptedThroughUpdateId: 2, upsertedEntries: [{ ...entries[0], updateId: 2, update: { update_id: 2 } }], removedUpdateIds: [] };
      await writeFile(path, JSON.stringify(snapshot));
      const target = join(`${path}.segments`, "0000000000000002.json");
      await writeFile(target, JSON.stringify(segment));
      const result = inspectTelegramUpdateJournalFamily(input);
      assert.equal(result.kind, "present");
      assert.deepEqual(readTelegramUpdateJournalSource({ ...input, version }), result);
      if (result.kind === "present") {
        assert.deepEqual(result.file.entries, [...entries, ...segment.upsertedEntries]);
        assert.deepEqual(result.file.botIdentity, botIdentity);
        assert.equal(result.accounting.work, 4);
      }
      for (const bounded of [{ ...limits, maxEntries: 1 }, { ...limits, maxWork: 3 }]) {
        assert.throws(() => inspectTelegramUpdateJournalFamily({ ...input, limits: bounded }), e => isJournalError(e, "capacity"));
        assert.throws(() => readTelegramUpdateJournalSource({ ...input, version, limits: bounded }), e => isJournalError(e, "capacity"));
      }
      for (const key of ["upsertedEntries", "removedUpdateIds", "operatorDispositions"]) {
        await writeFile(target, JSON.stringify({ ...segment, [key]: Array(11).fill(null) }));
        assert.throws(() => inspectTelegramUpdateJournalFamily(input), e => isJournalError(e, "capacity"));
      }
      await writeFile(target, JSON.stringify({ ...segment, upsertedEntries: [], removedUpdateIds: [] }));
      await writeFile(path, JSON.stringify({ ...snapshot, entries: Array(11).fill(entries[0]) }));
      assert.throws(() => inspectTelegramUpdateJournalFamily(input), e => isJournalError(e, "capacity"));
      await writeFile(path, JSON.stringify(snapshot));
      if (version === 2) {
        await writeFile(target, JSON.stringify({ ...segment, upsertedEntries: [{ ...entries[0], preApprovalExcluded: true }] }));
        assert.throws(() => inspectTelegramUpdateJournalFamily(input), e => isJournalError(e, "pairing-evidence"));
        await writeFile(path, JSON.stringify({ ...snapshot, entries: [] }));
        await writeFile(target, JSON.stringify({ ...segment, upsertedEntries: entries }));
        assert.throws(() => inspectTelegramUpdateJournalFamily(input), e => isJournalError(e, "pairing-evidence"));
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Strict family inspection preserves legacy failures, queue owners and handoffs", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-strict-metadata-")));
  const path = join(dir, "journal.json");
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-metadata" });
  const owner = { instanceId: "owner", processId: 123, processBirthId: "synthetic-birth", sessionGeneration: 7 };
  const queued = { updateId: 1, update: { update_id: 1 }, admittedAtMs: 1, state: "queued",
    queueKind: "prompt", queueReceiptId: "receipt", queueOwner: { ...owner, acquisitionId: "acquisition", acquiredAtMs: 2 },
    queueHandoff: { handoffId: "handoff", offeredAtMs: 3, recipientOwner: { ...owner, instanceId: "recipient" } } };
  const failed = { updateId: 2, update: { update_id: 2 }, admittedAtMs: 1, state: "failed",
    failure: { attemptCount: 2, failedAtMs: 10, failureClass: "legacy-terminal", summary: "Synthetic failure" },
    terminalAtMs: 10, terminalReason: "terminal:legacy-terminal" };
  try {
    for (const version of [1, 2] as const) {
      const entries = [queued, failed].map(entry => ({ ...entry, ...(version === 2 ? { preApprovalExcluded: false } : {}) }));
      const raw = { version, profile: "default", botIdentity, entries, ...(version === 2 ? { acceptedThroughUpdateId: 2 } : {}) };
      const text = JSON.stringify(raw);
      await writeFile(path, text);
      const input = { directory: dir, path, profile: "default", botIdentity,
        limits: { maxFiles: 1, maxBytes: 100_000, maxEntries: 10, maxWork: 100 } };
      if (!assertUnsupportedStrictInspection(input, context)) {
        const first = inspectTelegramUpdateJournalFamily(input);
        const second = inspectTelegramUpdateJournalFamily(input);
        assert.deepEqual(readTelegramUpdateJournalSource({ ...input, version }), first);
        assert.deepEqual(second, first);
        assert.equal(first.kind, "present");
        if (first.kind === "present") {
          assert.deepEqual(first.file.entries[0], entries[0]);
          assert.deepEqual(first.file.entries[1], { ...entries[1], terminalFailureId: first.file.entries[1]!.terminalFailureId });
          assert.match(first.file.entries[1]!.terminalFailureId!, /^failure-[a-f0-9]{32}$/u);
          assert.equal(first.file.revision, undefined);
          assert.equal(first.file.acceptedThroughUpdateId, version === 2 ? 2 : undefined);
        }
      }
      assert.equal(await readFile(path, "utf8"), text);
      assert.deepEqual(await readdir(dir), ["journal.json"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Canonical namespace inventory shares budgets, orders families and preserves foreign evidence", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-inventory-")));
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-inventory" });
  const limits = { maxDirectoryEntries: 20, maxFiles: 20, maxBytes: 100_000, maxEntries: 10, maxWork: 20 };
  const input = { directory: dir, profile: "default", botIdentity, limits };
  const inspect = () => inspectTelegramProfileJournalNamespace(input);
  try {
    if (assertUnsupportedStrictInspection({ ...input, path: join(dir, "inbox.json") }, context, inspect)) {
      assert.deepEqual(await readdir(dir), []);
      return;
    }
    assert.deepEqual(inspect().accounting, { directoryEntries: 0, files: 0, bytes: 0, work: 1 });
    for (const profile of ["default", "work"]) {
      input.profile = profile;
      const suffix = profile === "default" ? "" : ".work";
      const names = ["bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"].map(hash => `follower-inbox-${hash}${suffix}.json`);
      const snapshot = JSON.stringify({ version: 1, revision: 1, profile, botIdentity, entries: [] });
      for (const name of names) { await writeFile(join(dir, name), snapshot); await mkdir(join(dir, `${name}.segments`)); }
      await writeFile(join(dir, "unrelated"), "untouched");
      await writeFile(join(dir, "inbox.foreign.json"), "invalid JSON, never decoded");
      const before = names.map(name => fs.readFileSync(join(dir, name), "utf8"));
      const originalOpen = fs.openSync;
      const opened: string[] = [];
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        opened.push(String(args[0]));
        return Reflect.apply(originalOpen, fs, args);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      let result: ReturnType<typeof inspect>;
      try { result = inspect(); }
      finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
      assert.deepEqual(opened.sort(), names.map(name => join(dir, name)).sort(), "Only current-profile family files may be opened");
      assert.deepEqual(result.sources.map(source => source.path), [join(dir, `inbox${suffix}.json`), ...names.sort().map(name => join(dir, name))]);
      assert.equal(result.sources[0]!.evidence.kind, "absent");
      assert.deepEqual(result.accounting, { directoryEntries: 6, files: 2, bytes: 2 * Buffer.byteLength(snapshot), work: 3 });
      const exact = { ...limits, maxDirectoryEntries: 6, maxFiles: 2, maxBytes: result.accounting.bytes, maxWork: 3 };
      assert.deepEqual(inspectTelegramProfileJournalNamespace({ ...input, limits: exact }), result);
      for (const key of ["maxDirectoryEntries", "maxFiles", "maxBytes", "maxWork"] as const) {
        assert.throws(() => inspectTelegramProfileJournalNamespace({ ...input, limits: { ...exact, [key]: exact[key] - 1 } }), e => isJournalError(e, "capacity"));
      }
      assert.deepEqual(names.map(name => fs.readFileSync(join(dir, name), "utf8")), before);
      assert.equal(await readFile(join(dir, "inbox.foreign.json"), "utf8"), "invalid JSON, never decoded");
      const entries = [1, 2].map(updateId => ({ updateId, update: { update_id: updateId }, admittedAtMs: 1, state: "pending" }));
      for (const name of names) await writeFile(join(dir, name), JSON.stringify({ version: 1, profile, botIdentity, entries }));
      const decoded = inspectTelegramProfileJournalNamespace({ ...input, limits: { ...limits, maxWork: 5 } });
      assert.equal(decoded.accounting.work, 5);
      assert.throws(() => inspectTelegramProfileJournalNamespace({ ...input, limits: { ...limits, maxWork: 4 } }), e => isJournalError(e, "capacity"));
      assert.throws(() => inspectTelegramProfileJournalNamespace({ ...input, limits: { ...limits, maxEntries: 1 } }), e => isJournalError(e, "capacity"));
      for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Canonical namespace rejects aliases, residue, foreign links/types and recovery without traversal", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-inventory-reject-")));
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-inventory" });
  const input = { directory: dir, profile: "default", botIdentity,
    limits: { maxDirectoryEntries: 20, maxFiles: 20, maxBytes: 100_000, maxEntries: 10, maxWork: 20 } };
  const inspect = () => inspectTelegramProfileJournalNamespace(input);
  try {
    if (assertUnsupportedStrictInspection({ ...input, path: join(dir, "inbox.json") }, context, inspect)) return;
    for (const profile of ["Default", "work-x", "a".repeat(33), "", "work.x"]) {
      assert.throws(() => inspectTelegramProfileJournalNamespace({ ...input, profile }), TelegramUpdateJournalError);
    }
    for (const name of ["Inbox.json", "inbox.default.json", "inbox.Work.json", "inbox.a-b.json", "inbox.json.tmp", "follower-inbox-bad.json", "follower-inbox-AAAAAAAAAAAAAAAA.json", "recovery", "Recovery"]) {
      await writeFile(join(dir, name), "unchanged");
      assert.throws(inspect, TelegramUpdateJournalError, name);
      assert.equal(await readFile(join(dir, name), "utf8"), "unchanged");
      await rm(join(dir, name));
    }
    for (const name of ["inbox.foreign.json", "follower-inbox-aaaaaaaaaaaaaaaa.json", "recovery"]) {
      await symlink(join(dir, "does-not-exist"), join(dir, name));
      assert.throws(inspect, TelegramUpdateJournalError);
      assert.equal(await readlink(join(dir, name)), join(dir, "does-not-exist"));
      await rm(join(dir, name));
    }
    for (const name of ["inbox.foreign.json", "follower-inbox-aaaaaaaaaaaaaaaa.json.segments"]) {
      await mkdir(join(dir, name));
      assert.throws(inspect, TelegramUpdateJournalError);
      await rm(join(dir, name), { recursive: true });
    }
    await writeFile(join(dir, "inbox.foreign.json.segments"), "wrong type");
    assert.throws(inspect, TelegramUpdateJournalError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Canonical namespace carries segment-only bot constraints and detects root changes and vanished families", async (context) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-inventory-identity-")));
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "synthetic-inventory" });
  const input = { directory: dir, profile: "default", botIdentity,
    limits: { maxDirectoryEntries: 20, maxFiles: 20, maxBytes: 100_000, maxEntries: 10, maxWork: 20 } };
  const inspect = () => inspectTelegramProfileJournalNamespace(input);
  const paths = [join(dir, "inbox.json"), join(dir, "follower-inbox-aaaaaaaaaaaaaaaa.json")];
  try {
    if (assertUnsupportedStrictInspection({ ...input, path: paths[0]! }, context, inspect)) return;
    for (const [index, path] of paths.entries()) {
      await writeFile(path, JSON.stringify({ version: 1, revision: 1, profile: "default", botIdentity, entries: [] }));
      await mkdir(`${path}.segments`);
      await writeFile(join(`${path}.segments`, "0000000000000001.json"), JSON.stringify({ version: 1, revision: 1, previousRevision: 0,
        profile: "default", botIdentity: { ...botIdentity, botId: index + 1 }, upsertedEntries: [], removedUpdateIds: [] }));
    }
    assert.throws(inspect, e => isJournalError(e, "identity-mismatch"));
    await rm(`${paths[1]}.segments`, { recursive: true });
    const result = inspect();
    assert.equal(result.knownBotId, 1);
    for (const source of result.sources) if (source.evidence.kind === "present") {
      assert.equal(source.evidence.knownBotId, 1);
      assert.deepEqual(source.evidence.file.botIdentity, botIdentity);
    }
    for (const mutation of [() => writeFileSync(join(dir, "new-unrelated"), "new"), () => fs.unlinkSync(paths[1]!)]) {
      input.limits.maxDirectoryEntries = (await readdir(dir)).length;
      const original = fs.readSync;
      let changed = false;
      fs.readSync = ((...args: Parameters<typeof readSync>) => {
        const count = Reflect.apply(original, fs, args) as number;
        if (!changed) { changed = true; mutation(); }
        return count;
      }) as typeof readSync;
      syncBuiltinESMExports();
      try { assert.throws(inspect, TelegramUpdateJournalError); }
      finally { fs.readSync = original; syncBuiltinESMExports(); }
      assert.equal(changed, true);
    }
    // A change after the last family read must still be caught by the root recensus.
    input.limits.maxDirectoryEntries = 20;
    const originalOpenDirectory = fs.opendirSync;
    let rootScans = 0;
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      if (String(args[0]) === dir && ++rootScans === 2) {
        writeFileSync(join(dir, "late-root-entry"), "created after family inspection");
      }
      return Reflect.apply(originalOpenDirectory, fs, args);
    }) as typeof fs.opendirSync;
    syncBuiltinESMExports();
    try { assert.throws(inspect, e => isJournalError(e, "invalid")); }
    finally { fs.opendirSync = originalOpenDirectory; syncBuiltinESMExports(); }
    assert.equal(rootScans, 2);
    assert.equal(await readFile(join(dir, "late-root-entry"), "utf8"), "created after family inspection");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function isJournalError(
  error: unknown,
  code: TelegramUpdateJournalError["code"],
): boolean {
  return error instanceof TelegramUpdateJournalError && error.code === code;
}

function runJournalWorker(
  path: string,
  worker: number,
  count: number,
  mode = "append",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        workerPath,
        path,
        String(worker),
        String(count),
        mode,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`journal worker exited ${exitCode}: ${stderr}`));
    });
  });
}

async function withJournalTempDir(
  run: (input: { dir: string; path: string }) => Promise<void>,
): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-telegram-journal-")));
  try {
    await run({ dir, path: join(dir, "inbox.work.json") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const identity = createTelegramUpdateJournalBotIdentity({
  botToken: "123:journal-secret",
  botId: 42,
});
const queueOwnerIdentity = {
  instanceId: "journal-test-instance",
  processId: process.pid,
  processBirthId: `${process.pid}:journal-test`,
  sessionGeneration: 1,
};

function createStore(
  path: string,
  options: {
    maxEntries?: number;
    maxBytes?: number;
    nowMs?: number;
    sourceAccess?: TelegramUpdateJournalStoreOptions["sourceAccess"];
    withSourceSerialization?: TelegramUpdateJournalStoreOptions["withSourceSerialization"];
    withPairingAdmission?: TelegramUpdateJournalStoreOptions["withPairingAdmission"];
    withPairedAdmission?: TelegramUpdateJournalStoreOptions["withPairedAdmission"];
    getQueueProcessLiveness?: (
      owner: { processId: number; processBirthId: string },
    ) => "alive" | "dead" | "unverifiable";
    workspaceAdmission?: Pick<
      TelegramWorkspaceAdmissionLedger,
      "acquireAdmission" | "releaseAdmission"
    >;
    onPublicationBoundary?: (
      boundary: "before-write" | "after-write-before-rename",
      publicationPath: string,
    ) => void;
    onRecovery?: (event: {
      kind: "repaired" | "reset";
      path: string;
      revision?: number;
      quarantinePath?: string;
      reason: string;
    }) => void;
  } = {},
) {
  return createTelegramUpdateJournalStore({
    path,
    profileName: "work",
    botIdentity: identity,
    maxEntries: options.maxEntries,
    maxBytes: options.maxBytes,
    getNowMs: () => options.nowMs ?? 1_000,
    queueRuntimeIdentity: {
      instanceId: queueOwnerIdentity.instanceId,
      processId: queueOwnerIdentity.processId,
      processBirthId: queueOwnerIdentity.processBirthId,
    },
    getQueueProcessLiveness: options.getQueueProcessLiveness,
    workspaceAdmission: options.workspaceAdmission,
    sourceAccess: options.sourceAccess,
    withSourceSerialization: options.withSourceSerialization,
    withPairingAdmission: options.withPairingAdmission,
    withPairedAdmission: options.withPairedAdmission,
    onPublicationBoundary: options.onPublicationBoundary,
    onRecovery: options.onRecovery,
  });
}

const sourceLimits = { maxFiles: 1024, maxBytes: 64 * 1024 * 1024, maxEntries: 10_000, maxWork: 10_000_000 };
const sourceTestOptions = { skip: !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK };

for (const liveSource of [false, true]) test(`Source serialization gates every store operation once while retaining receipt authority (live=${liveSource})`, { skip: liveSource && sourceTestOptions.skip }, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const configPath = join(dir, "telegram.json");
    const config = createTelegramConfigStore({ agentDir: dir, configPath });
    let acquisitions = 0;
    let held = false;
    let failPublication = false;
    const options: TelegramUpdateJournalStoreOptions = {
      path, profileName: "work", botIdentity: identity, getNowMs: () => 1000,
      ...(liveSource ? { sourceAccess: { directory: dir, limits: sourceLimits } } : {}),
      getQueueProcessLiveness: () => "dead",
      withSourceSerialization(operation) {
        acquisitions++;
        assert.equal(held, false);
        assert.equal(existsSync(`${path}.transaction`), false);
        return config.withSourceSerialization(() => {
          held = true;
          try { return operation(); } finally { held = false; }
        });
      },
      onPublicationBoundary() {
        assert.equal(held, true);
        assert.equal(existsSync(`${configPath}.transaction`), true);
        assert.equal(existsSync(`${path}.transaction`), true);
        if (failPublication) throw new Error("synthetic publication failure");
      },
    };
    const store = createTelegramUpdateJournalStore({ ...options, queueRuntimeIdentity: queueOwnerIdentity });
    const recipientOwner = { ...queueOwnerIdentity, instanceId: "recipient", processId: process.pid + 1, processBirthId: "synthetic-recipient" };
    const recipient = createTelegramUpdateJournalStore({ ...options, queueRuntimeIdentity: recipientOwner });
    const once = <T>(operation: () => T): T => {
      const before = acquisitions;
      try { return operation(); } finally {
        assert.equal(acquisitions, before + 1);
        assert.equal(held, false);
        assert.equal(existsSync(`${configPath}.transaction`), false);
        assert.equal(existsSync(`${path}.transaction`), false);
      }
    };
    assert.equal(once(() => store.read()).version, 1);
    once(() => store.appendBatch(Array.from({ length: 6 }, (_, i) => ({ update_id: i + 1 }))));
    const receipt = { queueKind: "prompt" as const, receiptId: "synthetic", sourceUpdateIds: [1] };
    const owner = once(() => store.markQueued({ ...receipt, owner: queueOwnerIdentity })).queueOwner!;
    const handoff = { ...receipt, expectedOwner: owner,
      recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken() };
    once(() => store.offerQueuedHandoff(handoff));
    once(() => store.cancelQueuedHandoff(handoff));
    once(() => store.offerQueuedHandoff(handoff));
    const accepted = once(() => recipient.acceptQueuedHandoff(handoff));
    assert.throws(() => once(() => store.completeQueued([{ ...receipt, queueOwner: owner }])),
      (error) => isJournalError(error, "conflict"));
    once(() => recipient.completeQueued([{ ...receipt, queueOwner: accepted.queueOwner }]));
    const discardReceipt = { ...receipt, receiptId: "discard", sourceUpdateIds: [2] };
    const discardedOwner = once(() => store.markQueued({ ...discardReceipt, owner: queueOwnerIdentity })).queueOwner!;
    once(() => store.discardQueued({ ...discardReceipt, expectedOwner: discardedOwner }));
    const deadReceipt = { ...receipt, receiptId: "dead", sourceUpdateIds: [3] };
    const deadOwner = once(() => store.markQueued({ ...deadReceipt, owner: queueOwnerIdentity })).queueOwner!;
    once(() => store.recoverDeadQueueOwner({ ...deadReceipt, deadOwner, recoveryOwner: queueOwnerIdentity }));
    const failed = once(() => store.markExecutionFailure({ updateId: 4, expectedAttemptCount: 0,
      failedAtMs: 1100, failureClass: "synthetic", summary: "synthetic", disposition: "failed", terminalReason: "synthetic" }));
    once(() => store.applyOperatorDisposition({ updateId: 4, failureId: failed.entry.terminalFailureId!, action: "discard" }));
    once(() => store.removeCompleted([5, 6]));
    assert.deepEqual(once(() => store.read()).entries, []);
    failPublication = true;
    assert.throws(() => once(() => store.appendBatch([{ update_id: 7 }])) , (error) => isJournalError(error, "io"));
    failPublication = false;
    assert.deepEqual(once(() => store.appendBatch([{ update_id: 7 }])).addedUpdateIds, [7]);
    assert.equal(existsSync(configPath), false, "Lock-only operations do not create config authority");
  });
});

test("Live v1 publication refuses an omitted cursor that would trail new entries", sourceTestOptions, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
    let publications = 0;
    const store = createStore(path, { sourceAccess: { directory: dir, limits: sourceLimits },
      withSourceSerialization: config.withSourceSerialization,
      onPublicationBoundary() { publications++; } });
    store.appendBatch([{ update_id: 1 }], 1);
    const before = store.read();
    const bytes = await readFile(path);
    publications = 0;
    assert.throws(() => store.appendBatch([{ update_id: 2 }]), TelegramUpdateJournalError);
    assert.equal(publications, 0);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(existsSync(`${path}.segments`), false);
    assert.deepEqual(store.read(), before);
    assert.equal(existsSync(`${path}.transaction`), false);
    assert.equal(existsSync(join(dir, "telegram.json.transaction")), false);
    assert.deepEqual(store.appendBatch([{ update_id: 2 }], 2).addedUpdateIds, [2]);
    assert.equal(store.read().acceptedThroughUpdateId, 2);
    const cursorless = createStore(join(dir, "cursorless.json"), {
      sourceAccess: { directory: dir, limits: sourceLimits }, withSourceSerialization: config.withSourceSerialization });
    cursorless.appendBatch([{ update_id: 20 }]);
    cursorless.appendBatch([{ update_id: 10 }]);
    assert.equal(cursorless.read().acceptedThroughUpdateId, undefined);
    assert.deepEqual(cursorless.read().entries.map(entry => entry.updateId), [10, 20]);
  });
});

for (const version of [1, 2] as const) test(`Live v${version} publication refuses generated attempt overflow before writing`, sourceTestOptions, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
    let publications = 0;
    const store = createStore(path, { sourceAccess: { directory: dir, limits: sourceLimits },
      withSourceSerialization: config.withSourceSerialization,
      ...(version === 2 ? { withPairingAdmission: <T>(publish: (excluded: boolean) => T) =>
        config.withSourceSerialization(() => publish(false)) } : {}),
      onPublicationBoundary() { publications++; } });
    await writeFile(path, JSON.stringify({ version, profile: "work", botIdentity: identity,
      acceptedThroughUpdateId: 1, entries: [{ updateId: 1, update: { update_id: 1 }, admittedAtMs: 1,
        state: "retry-wait", nextRetryAtMs: 2,
        ...(version === 2 ? { preApprovalExcluded: false } : {}),
        failure: { attemptCount: Number.MAX_SAFE_INTEGER - 1, failedAtMs: 1,
          failureClass: "synthetic", summary: "synthetic" } }] }));
    assert.equal(store.read().entries[0]?.failure?.attemptCount, Number.MAX_SAFE_INTEGER - 1);
    const failure = { updateId: 1, failedAtMs: 3, nextRetryAtMs: 4,
      failureClass: "synthetic", summary: "synthetic", disposition: "retry-wait" as const };
    store.markExecutionFailure({ ...failure, expectedAttemptCount: Number.MAX_SAFE_INTEGER - 1 });
    const before = store.read();
    assert.equal(before.entries[0]?.failure?.attemptCount, Number.MAX_SAFE_INTEGER);
    const segmentPath = join(`${path}.segments`, "0000000000000001.json");
    const snapshotBytes = await readFile(path);
    const segmentBytes = await readFile(segmentPath);
    publications = 0;
    assert.throws(() => store.markExecutionFailure({ ...failure, expectedAttemptCount: Number.MAX_SAFE_INTEGER }),
      TelegramUpdateJournalError);
    assert.equal(publications, 0);
    assert.deepEqual(await readFile(path), snapshotBytes);
    assert.deepEqual(await readFile(segmentPath), segmentBytes);
    assert.deepEqual(await readdir(`${path}.segments`), ["0000000000000001.json"]);
    assert.deepEqual(store.read(), before);
    assert.equal(existsSync(`${path}.transaction`), false);
    assert.equal(existsSync(join(dir, "telegram.json.transaction")), false);
    assert.deepEqual(store.removeCompleted([1]).removedUpdateIds, [1]);
    assert.deepEqual(store.read().entries, []);
  });
});

test("Live source refuses references and retained authority before journal staging", sourceTestOptions, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
    assert.throws(() => createStore(path, { sourceAccess: { directory: dir, limits: sourceLimits } }), /requires source serialization/);
    const options = { sourceAccess: { directory: dir, limits: sourceLimits }, withSourceSerialization: config.withSourceSerialization,
      onRecovery() { assert.fail("Strict access must not recover"); }, onPublicationBoundary() { assert.fail("Invalid source must not publish"); } };
    const original = fs.mkdtempSync;
    const rejected = (store: ReturnType<typeof createStore>) => {
      fs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
        assert.equal(String(args[0]).includes("inbox"), false, "Source rejection precedes journal transaction staging");
        return Reflect.apply(original, fs, args);
      }) as typeof fs.mkdtempSync;
      syncBuiltinESMExports();
      try {
        for (const method of Object.keys(store) as (keyof typeof store)[]) {
          assert.throws(() => method === "appendBatch" ? store.appendBatch([{ update_id: 1 }])
            : (store[method] as (input: never) => unknown)({} as never), (error) => error instanceof TelegramUpdateJournalError);
        }
      } finally { fs.mkdtempSync = original; syncBuiltinESMExports(); }
    };
    for (const [directory, reference] of [[dir, "relative/inbox.json"], [join(dir, "approved"), path],
      [join(dir, "missing"), join(dir, "missing/inbox.json")], [dir, join(dir, "missing/inbox.json")]]) {
      rejected(createStore(reference!, { ...options, sourceAccess: { directory: directory!, limits: sourceLimits } }));
      assert.equal(existsSync(join(dir, "missing")), false);
    }
    const valid = { version: 1, profile: "work", botIdentity: identity, entries: [] };
    for (const value of ["{", JSON.stringify({ ...valid, profile: "foreign" }), JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, botIdentity: { ...identity, tokenSha256: "b".repeat(64) } }),
      JSON.stringify({ ...valid, botIdentity: { tokenSha256: identity.tokenSha256 } })]) {
      await writeFile(path, value);
      rejected(createStore(path, options));
      assert.equal(await readFile(path, "utf8"), value);
      assert.deepEqual((await readdir(dir)).sort(), ["inbox.work.json"]);
    }
  });
});

test("Live source logical revision bytes and physical publication limits are independent and captured", sourceTestOptions, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
    const access = { directory: dir, limits: { ...sourceLimits } };
    const options = { sourceAccess: access, withSourceSerialization: config.withSourceSerialization };
    const store = createStore(path, options);
    access.directory = join(dir, "missing");
    access.limits.maxFiles = 1;
    store.appendBatch([{ update_id: 1 }]);
    const published = store.appendBatch([{ update_id: 2 }]);
    const input = { directory: dir, path, profile: "work", botIdentity: identity, limits: sourceLimits, version: 1 as const };
    const evidence = readTelegramUpdateJournalSource(input);
    assert.equal(evidence.kind, "present");
    if (evidence.kind !== "present") return;
    const logical = Buffer.byteLength(`${JSON.stringify(evidence.file, null, 2)}\n`);
    assert.equal(published.serializedBytes, logical);
    assert.equal(store.read().serializedBytes, logical);
    assert.ok(evidence.accounting.bytes > logical);
    const before = await readFile(join(`${path}.segments`, "0000000000000001.json"), "utf8");
    for (const limits of [
      { ...sourceLimits, maxFiles: evidence.accounting.files },
      { ...sourceLimits, maxBytes: evidence.accounting.bytes },
      { ...sourceLimits, maxWork: evidence.accounting.work },
      { ...sourceLimits, maxEntries: 2 },
    ]) {
      const bounded = createStore(path, { ...options, sourceAccess: { directory: dir, limits } });
      assert.equal(bounded.read().entries.length, 2);
      assert.throws(() => bounded.appendBatch([{ update_id: 3 }]), (error) => isJournalError(error, "capacity"));
      assert.equal(existsSync(join(`${path}.segments`, "0000000000000002.json")), false);
      assert.equal(existsSync(`${path}.transaction`), false);
      assert.equal(existsSync(join(dir, "telegram.json.transaction")), false);
      assert.equal(await readFile(join(`${path}.segments`, "0000000000000001.json"), "utf8"), before);
    }
    assert.equal(createStore(path, { sourceAccess: { directory: dir, limits: sourceLimits },
      withSourceSerialization: config.withSourceSerialization, maxBytes: logical }).read().serializedBytes, logical);
    assert.throws(() => createStore(path, { sourceAccess: { directory: dir, limits: sourceLimits },
      withSourceSerialization: config.withSourceSerialization, maxBytes: logical - 1 }).read(), (error) => isJournalError(error, "capacity"));
    assert.deepEqual(store.appendBatch([{ update_id: 3 }]).addedUpdateIds, [3]);
  });
});

for (const version of [1, 2] as const) for (const interruption of ["none", "snapshot", "cleanup"] as const) {
  test(`Live compaction preserves receipt scope and redundant identity witness (v${version}, ${interruption})`, sourceTestOptions, async () => {
    await withJournalTempDir(async ({ dir, path }) => {
      const tokenOnly = { tokenSha256: identity.tokenSha256 };
      const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
      let interrupt = false;
      const options: TelegramUpdateJournalStoreOptions = { path, profileName: "work", botIdentity: tokenOnly,
        getNowMs: () => 1000, sourceAccess: { directory: dir, limits: sourceLimits },
        withSourceSerialization: config.withSourceSerialization,
        ...(version === 2 ? { withPairingAdmission: <T>(publish: (excluded: boolean) => T) => config.withSourceSerialization(() => publish(false)) } : {}),
        onPublicationBoundary(boundary, publicationPath) {
          if (interrupt && interruption === "snapshot" && publicationPath === path && boundary === "after-write-before-rename") {
            throw new Error("Synthetic snapshot interruption");
          }
        } };
      const store = createTelegramUpdateJournalStore(options);
      store.appendBatch([{ update_id: 1 }], 1);
      const receipt = { queueKind: "prompt" as const, receiptId: "retained", sourceUpdateIds: [1] };
      const owner = store.markQueued({ ...receipt, owner: queueOwnerIdentity }).queueOwner!;
      const input = { directory: dir, path, profile: "work", botIdentity: tokenOnly, version, limits: sourceLimits };
      const scope = createTelegramUpdateJournalReceiptScope({ profileName: "work", botIdentity: tokenOnly });
      const snapshot = store.read();
      const file = { version, revision: 1, profile: "work", botIdentity: tokenOnly,
        acceptedThroughUpdateId: 1, entries: snapshot.entries };
      await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
      const witnessPath = join(`${path}.segments`, "0000000000000001.json");
      const witness = JSON.parse(await readFile(witnessPath, "utf8"));
      witness.botIdentity.botId = 42;
      await writeFile(witnessPath, JSON.stringify(witness));
      for (let revision = 2; revision <= 256; revision++) {
        await writeFile(join(`${path}.segments`, `${String(revision).padStart(16, "0")}.json`), JSON.stringify({
          version, revision, previousRevision: revision - 1, profile: "work", botIdentity: tokenOnly,
          acceptedThroughUpdateId: revision, upsertedEntries: [], removedUpdateIds: [],
        }));
      }
      const acquired = readTelegramUpdateJournalSource(input);
      assert.equal(acquired.kind, "present");
      if (acquired.kind !== "present") return;
      assert.equal(acquired.knownBotId, 42);
      assert.deepEqual(acquired.file.botIdentity, tokenOnly);
      if (version === 1 && interruption === "none") {
        const nextSegment = { version, revision: 257, previousRevision: 256, profile: "work", botIdentity: tokenOnly,
          upsertedEntries: [], removedUpdateIds: [], acceptedThroughUpdateId: 257 };
        const segmentBytes = Buffer.byteLength(`${JSON.stringify(nextSegment, null, 2)}\n`);
        const bounded = createTelegramUpdateJournalStore({ ...options,
          sourceAccess: { directory: dir, limits: { ...sourceLimits, maxBytes: acquired.accounting.bytes + segmentBytes } },
          onPublicationBoundary() { assert.fail("Snapshot cleanup residue capacity must be checked before segment publication"); } });
        assert.throws(() => bounded.appendBatch([], 257), (error) => isJournalError(error, "capacity"));
        assert.equal(existsSync(join(`${path}.segments`, "0000000000000257.json")), false);
        assert.deepEqual(readTelegramUpdateJournalSource(input), acquired);
      }
      const originalUnlink = fs.unlinkSync;
      if (interruption === "cleanup") {
        fs.unlinkSync = ((target: fs.PathLike) => {
          if (String(target).startsWith(`${path}.segments/`)) throw new Error("Synthetic cleanup refusal");
          return originalUnlink(target);
        }) as typeof fs.unlinkSync;
        syncBuiltinESMExports();
      }
      interrupt = true;
      try {
        if (interruption === "snapshot") assert.throws(() => store.appendBatch([], 257), (error) => isJournalError(error, "io"));
        else {
          const result = store.appendBatch([], 257);
          const after = readTelegramUpdateJournalSource(input);
          assert.equal(after.kind, "present");
          if (after.kind === "present") assert.equal(result.serializedBytes, Buffer.byteLength(`${JSON.stringify(after.file, null, 2)}\n`));
        }
      } finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); interrupt = false; }
      const after = readTelegramUpdateJournalSource(input);
      assert.equal(after.kind, "present");
      if (after.kind !== "present") return;
      assert.equal(after.file.revision, 257);
      assert.equal(after.knownBotId, 42);
      assert.deepEqual(after.file.botIdentity, tokenOnly);
      assert.equal(createTelegramUpdateJournalReceiptScope({ profileName: "work", botIdentity: after.file.botIdentity }), scope);
      assert.deepEqual(after.file.entries[0]?.queueOwner, owner);
      if (version === 2) assert.equal(after.file.entries[0]?.preApprovalExcluded, false);
      assert.equal(existsSync(witnessPath), true);
      assert.equal((await readdir(`${path}.segments`)).length, interruption === "none" ? 1 : 257);
      assert.throws(() => readTelegramUpdateJournalSource({ ...input, botIdentity: { ...tokenOnly, botId: 99 } }),
        (error) => isJournalError(error, "identity-mismatch"));
      if (interruption === "snapshot") store.appendBatch([], 258);
      assert.throws(() => store.completeQueued([{ ...receipt, queueOwner: { ...owner, acquisitionId: "wrong" } }]),
        (error) => isJournalError(error, "conflict"));
      assert.deepEqual(store.completeQueued([{ ...receipt, queueOwner: owner }]).removedUpdateIds, [1]);
      assert.deepEqual(store.read().botIdentity, tokenOnly);
      assert.equal(existsSync(witnessPath), true);
    });
  });
}

test("Live exact accepted receipts survive current config credential changes without adopting them", sourceTestOptions, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const configPath = join(dir, "telegram.json");
    await writeFile(configPath, JSON.stringify({ profiles: { work: { botToken: "123:journal-secret", allowedUserId: 7 } } }));
    const config = createTelegramConfigStore({ agentDir: dir, configPath });
    await config.load();
    config.activateProfile("work");
    const options = { sourceAccess: { directory: dir, limits: sourceLimits }, withSourceSerialization: config.withSourceSerialization,
      withPairedAdmission: <T>(_updates: readonly unknown[], publish: () => T) =>
        config.withPairedUserAdmission("work", identity.tokenSha256, 7, publish) };
    const store = createStore(path, options);
    store.appendBatch([{ update_id: 1 }]);
    const receipt = { queueKind: "prompt" as const, receiptId: "old-authority", sourceUpdateIds: [1] };
    const owner = store.markQueued({ ...receipt, owner: queueOwnerIdentity }).queueOwner!;
    const changedConfig = JSON.stringify({ profiles: { work: { botToken: "synthetic-rotated", allowedUserId: 99 } } });
    await writeFile(configPath, changedConfig);
    assert.throws(() => store.appendBatch([{ update_id: 2 }]));
    assert.throws(() => store.completeQueued([{ ...receipt, queueOwner: { ...owner, acquisitionId: "wrong" } }]),
      (error) => isJournalError(error, "conflict"));
    assert.deepEqual(store.completeQueued([{ ...receipt, queueOwner: owner }]).removedUpdateIds, [1]);
    assert.deepEqual(store.read().botIdentity, identity);
    assert.equal(await readFile(configPath, "utf8"), changedConfig);
    const rotated = createTelegramUpdateJournalStore({ path, profileName: "work", botIdentity: { ...identity, tokenSha256: "c".repeat(64) },
      sourceAccess: options.sourceAccess, withSourceSerialization: config.withSourceSerialization });
    assert.throws(() => rotated.read(), (error) => isJournalError(error, "identity-mismatch"));
  });
});

test("Live consumption and publication do not return to ordinary journal scans", sourceTestOptions, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
    const store = createStore(path, { sourceAccess: { directory: dir, limits: sourceLimits }, withSourceSerialization: config.withSourceSerialization });
    const originalRead = fs.readFileSync;
    const originalCensus = fs.readdirSync;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === path) throw new Error("Ordinary snapshot read is not source consumption");
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readFileSync;
    fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === `${path}.segments`) throw new Error("Ordinary unbounded segment census");
      return Reflect.apply(originalCensus, fs, args);
    }) as typeof fs.readdirSync;
    syncBuiltinESMExports();
    try {
      assert.equal(store.read().exists, false);
      store.appendBatch([{ update_id: 1 }]);
      store.appendBatch([{ update_id: 2 }]);
      store.removeCompleted([1]);
      assert.deepEqual(store.read().entries.map((entry) => entry.updateId), [2]);
      assert.throws(() => createStore(path).read(), (error) => isJournalError(error, "io"));
    } finally { fs.readFileSync = originalRead; fs.readdirSync = originalCensus; syncBuiltinESMExports(); }
  });
});

for (const initial of [true, false]) test(`Live publication process interruption leaves a readable family (initial=${initial})`, sourceTestOptions, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    if (!initial) createStore(path).appendBatch([{ update_id: 1 }]);
    const script = `
      import { createTelegramConfigStore } from ${JSON.stringify(new URL("../lib/config.ts", import.meta.url).href)};
      import { createTelegramUpdateJournalStore } from ${JSON.stringify(new URL("../lib/journal.ts", import.meta.url).href)};
      const config = createTelegramConfigStore({ agentDir: ${JSON.stringify(dir)}, configPath: ${JSON.stringify(join(dir, "telegram.json"))} });
      const store = createTelegramUpdateJournalStore({ path: ${JSON.stringify(path)}, profileName: 'work', botIdentity: ${JSON.stringify(identity)},
        sourceAccess: { directory: ${JSON.stringify(dir)}, limits: ${JSON.stringify(sourceLimits)} },
        withSourceSerialization: config.withSourceSerialization,
        onPublicationBoundary(boundary) { if (boundary === 'after-write-before-rename') process.exit(73); } });
      store.appendBatch([{ update_id: 2 }]);
      process.exit(74);
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 73, child.stderr);
    assert.ok((await readdir(dir)).some((name) => name.endsWith(".tmp")), "Actual process interruption retains staging");
    if (!initial) assert.deepEqual(await readdir(`${path}.segments`), [], "Segment staging must not pollute the strict namespace");
    // The owned child is terminal: no surviving writer can publish its staged transition.
    const evidence = readTelegramUpdateJournalSource({ directory: dir, path, profile: "work", botIdentity: identity,
      version: 1, limits: sourceLimits });
    assert.equal(evidence.kind, initial ? "absent" : "present");
    if (evidence.kind === "present") assert.deepEqual(evidence.file.entries.map((entry) => entry.updateId), [1]);
  });
});

test("Source guard rejection precedes every journal transaction and preserves corrupt/foreign evidence", async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const rejection = new Error("synthetic source rejection");
    let gates = 0;
    const store = createStore(path, {
      withSourceSerialization() {
        gates++;
        assert.equal(existsSync(`${path}.transaction`), false);
        throw rejection;
      },
      onRecovery() { assert.fail("Recovery before gate"); },
      onPublicationBoundary() { assert.fail("Publication before gate"); },
    });
    const receipt = { queueKind: "prompt" as const, receiptId: "synthetic", sourceUpdateIds: [1] };
    const owner = { ...queueOwnerIdentity, acquisitionId: "synthetic", acquiredAtMs: 1 };
    const handoff = { ...receipt, expectedOwner: owner, recipientOwner: queueOwnerIdentity, handoffToken: "synthetic" };
    const operations = [
      () => store.read(), () => store.appendBatch([{ update_id: 1 }]),
      () => store.markQueued({ ...receipt, owner: queueOwnerIdentity }),
      () => store.markExecutionFailure({ updateId: 1, expectedAttemptCount: 0, failedAtMs: 1,
        failureClass: "synthetic", summary: "synthetic", disposition: "failed", terminalReason: "synthetic" }),
      () => store.applyOperatorDisposition({ updateId: 1, failureId: "synthetic", action: "discard" }),
      () => store.offerQueuedHandoff(handoff), () => store.acceptQueuedHandoff(handoff),
      () => store.cancelQueuedHandoff(handoff),
      () => store.completeQueued([{ ...receipt, queueOwner: owner }]),
      () => store.discardQueued({ ...receipt, expectedOwner: owner }),
      () => store.recoverDeadQueueOwner({ ...receipt, deadOwner: owner, recoveryOwner: queueOwnerIdentity }),
      () => store.removeCompleted([1]),
    ];
    const originalMkdtemp = fs.mkdtempSync;
    const originalRead = fs.readFileSync;
    for (const evidence of ["{", JSON.stringify({ version: 1, profile: "foreign", botIdentity: identity, entries: [] })]) {
      await writeFile(path, evidence);
      fs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
        assert.equal(String(args[0]).startsWith(`${path}.transaction`), false, "Gate must precede transaction creation");
        return Reflect.apply(originalMkdtemp, fs, args);
      }) as typeof fs.mkdtempSync;
      fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        assert.notEqual(String(args[0]), path, "Gate must precede snapshot reads");
        return Reflect.apply(originalRead, fs, args);
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      try {
        for (const operation of operations) {
          const before = gates;
          assert.throws(operation, (error) => error === rejection);
          assert.equal(gates, before + 1);
        }
      } finally {
        fs.mkdtempSync = originalMkdtemp;
        fs.readFileSync = originalRead;
        syncBuiltinESMExports();
      }
      assert.equal(await readFile(path, "utf8"), evidence);
      assert.deepEqual(await readdir(dir), ["inbox.work.json"]);
    }
  });
});

for (const liveSource of [false, true]) test(`Bare v1 source serialization follows Workspace admission and shares canonical input once (live=${liveSource})`, { skip: liveSource && sourceTestOptions.skip }, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const configPath = join(dir, "telegram.json");
    const config = createTelegramConfigStore({ agentDir: dir, configPath });
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"), profileKey: "synthetic",
      owner: { processId: process.pid, processBirthId: `${process.pid}:synthetic` }, getProcessLiveness: () => "alive" });
    let held = false;
    let gates = 0;
    let normalizations = 0;
    const store = createStore(path, {
      ...(liveSource ? { sourceAccess: { directory: dir, limits: sourceLimits } } : {}),
      workspaceAdmission: {
        acquireAdmission(...args) {
          assert.equal(existsSync(`${configPath}.transaction`), false);
          assert.equal(existsSync(`${path}.transaction`), false);
          const result = ledger.acquireAdmission(...args);
          held = true;
          return result;
        },
        releaseAdmission(...args) {
          assert.equal(existsSync(`${configPath}.transaction`), false);
          assert.equal(existsSync(`${path}.transaction`), false);
          held = false;
          return ledger.releaseAdmission(...args);
        },
      },
      withSourceSerialization(operation) {
        gates++;
        assert.equal(held, true);
        assert.equal(existsSync(`${path}.transaction`), false);
        assert.ok(ledger.read().leases.some((lease) => lease.scope.kind === "chat" && lease.scope.chatId === 7));
        return config.withSourceSerialization(operation);
      },
      onPublicationBoundary() {
        assert.equal(held, true);
        assert.equal(existsSync(`${configPath}.transaction`), true);
        assert.equal(existsSync(`${path}.transaction`), true);
      },
    });
    store.appendBatch([{ update_id: 99, toJSON() { normalizations++; return { update_id: 1, message: { chat: { id: 7 } } }; } }]);
    assert.equal(gates, 1);
    assert.equal(normalizations, 1);
    assert.equal(held, false);
    assert.deepEqual(ledger.read().leases, []);
    const result = createStore(path).read();
    assert.equal(result.version, 1);
    assert.equal(result.entries[0]?.updateId, 1);
    assert.equal(result.entries[0]?.preApprovalExcluded, undefined);
  });
});

for (const liveSource of [false, true]) test(`Real config contention excludes every store operation; legacy read is a negative control (live=${liveSource})`, { skip: liveSource && sourceTestOptions.skip }, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const configPath = join(dir, "telegram.json");
    const config = createTelegramConfigStore({ agentDir: dir, configPath });
    const evidence = JSON.stringify({ version: 1, profile: "foreign", botIdentity: identity, entries: [] });
    await writeFile(path, evidence);
    const journalUrl = new URL("../lib/journal.ts", import.meta.url).href;
    const configUrl = new URL("../lib/config.ts", import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createTelegramConfigStore } from ${JSON.stringify(configUrl)};
      import { createTelegramUpdateJournalStore } from ${JSON.stringify(journalUrl)};
      Atomics.wait = () => 'timed-out';
      const configPath = ${JSON.stringify(configPath)};
      const original = fs.existsSync;
      let contentions = 0;
      fs.existsSync = (...args) => {
        const exists = Reflect.apply(original, fs, args);
        if (String(args[0]) === configPath + '.transaction' && exists) contentions++;
        return exists;
      };
      syncBuiltinESMExports();
      const config = createTelegramConfigStore({ agentDir: ${JSON.stringify(dir)}, configPath });
      const store = createTelegramUpdateJournalStore({ path: ${JSON.stringify(path)}, profileName: 'work',
        botIdentity: ${JSON.stringify(identity)}, withSourceSerialization: config.withSourceSerialization,
        ${liveSource ? `sourceAccess: ${JSON.stringify({ directory: dir, limits: sourceLimits })},` : ""} });
      const methods = Object.keys(store);
      for (const method of methods) {
        const before = contentions;
        try {
          if (method === 'appendBatch') store[method]([{ update_id: 1 }]);
          else store[method]({});
          throw new Error('Operation bypassed source serialization: ' + method);
        } catch (error) {
          if (!error.message.includes('Timed out acquiring Telegram lock transaction: ' + configPath + '.transaction')) throw error;
          if (contentions <= before) throw new Error('No actual acquisition contention: ' + method);
        }
      }
      console.log(JSON.stringify({ contentions, methods }));
    `;
    config.withSourceSerialization(() => {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
        { encoding: "utf8", timeout: 10_000 });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.ok(result.contentions > 0, "Actual failed acquisitions, not a pre-attempt marker");
      assert.deepEqual(result.methods.sort(), ["read", "appendBatch", "markQueued", "markExecutionFailure", "applyOperatorDisposition",
        "applyLegacyCustodyDisposition", "offerQueuedHandoff", "acceptQueuedHandoff", "cancelQueuedHandoff", "completeQueued", "discardQueued", "recoverDeadQueueOwner", "removeCompleted"].sort());
      assert.equal(fs.readFileSync(path, "utf8"), evidence);
      assert.equal(existsSync(`${path}.transaction`), false);
      assert.equal(existsSync(join(dir, "recovery")), false);
      // The same legacy reader can rewrite this empty foreign snapshot under grant exclusion.
      assert.equal(createStore(path).read().profile, "work");
      assert.notEqual(fs.readFileSync(path, "utf8"), evidence);
    });
    assert.equal(createStore(path, { withSourceSerialization: config.withSourceSerialization }).read().profile, "work");
  });
});

for (const liveSource of [false, true]) test(`Paired v1 journal holds Workspace/config/journal order and preserves unordered canonical deliveries (live=${liveSource})`, { skip: liveSource && sourceTestOptions.skip }, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const configPath = join(dir, "telegram.json");
    await writeFile(configPath, JSON.stringify({ profiles: { work: { botToken: "123:journal-secret" } } }));
    const config = createTelegramConfigStore({ agentDir: dir, configPath });
    await config.load();
    config.activateProfile("work");
    const ledger = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "admission.json"), profileKey: "fixture:work",
      owner: { processId: process.pid, processBirthId: `${process.pid}:paired-v1` }, getProcessLiveness: () => "alive",
    });
    let held = false;
    let current = true;
    let failWrite = false;
    let publications = 0;
    const store = createStore(path, {
      ...(liveSource ? { sourceAccess: { directory: dir, limits: sourceLimits } } : {}),
      workspaceAdmission: {
        acquireAdmission(...args) {
          assert.equal(existsSync(`${configPath}.transaction`), false);
          assert.equal(existsSync(`${path}.transaction`), false);
          const lease = ledger.acquireAdmission(...args);
          held = true;
          return lease;
        },
        releaseAdmission(...args) {
          assert.equal(existsSync(`${configPath}.transaction`), false);
          assert.equal(existsSync(`${path}.transaction`), false);
          held = false;
          return ledger.releaseAdmission(...args);
        },
      },
      withSourceSerialization: config.withSourceSerialization,
      withPairedAdmission(updates, publish) {
        assert.equal(held, true);
        assert.equal(existsSync(`${path}.transaction`), false);
        const message = updates[0]?.message as { from?: { id?: number }; chat?: { id?: number } } | undefined;
        const userId = message?.from?.id;
        if (typeof userId !== "number") return { admitted: false };
        assert.ok(ledger.read().leases.some((lease) => lease.scope.kind === "chat" && lease.scope.chatId === message?.chat?.id));
        return config.withPairedUserAdmission("work", identity.tokenSha256, userId, () => {
          assert.equal(config.getAllowedUserId(), userId);
          assert.equal(existsSync(`${configPath}.transaction`), true);
          assert.equal(existsSync(`${path}.transaction`), false);
          return publish();
        }, () => { if (!current) throw new Error("fixture stale receiver"); });
      },
      onPublicationBoundary(boundary) {
        assert.equal(held, true);
        assert.equal(existsSync(`${configPath}.transaction`), true);
        assert.equal(existsSync(`${path}.transaction`), true);
        publications++;
        if (failWrite && boundary === "after-write-before-rename") throw new Error("fixture failed publication");
      },
    });
    const delivery = (updateId: number, userId = 7) => ({ update_id: updateId, message: { chat: { id: 7 }, from: { id: userId } } });
    assert.throws(() => store.appendBatch([delivery(20)]), (error) => isJournalError(error, "sender-denied"));
    assert.equal(existsSync(path), false);
    assert.equal(config.getAllowedUserId(), undefined);
    assert.equal(held, false);
    const peer = createTelegramConfigStore({ agentDir: dir, configPath });
    await peer.load();
    peer.activateProfile("work");
    await peer.persistAllowedUserId(7);
    assert.deepEqual(store.appendBatch([delivery(20)]).addedUpdateIds, [20]);
    assert.deepEqual(store.appendBatch([delivery(10)]).addedUpdateIds, [10]);
    assert.deepEqual(store.appendBatch([delivery(20)]).duplicateUpdateIds, [20]);
    let normalizations = 0;
    store.appendBatch([{
      update_id: 30, message: { chat: { id: 999 }, from: { id: 999 } },
      toJSON() { normalizations++; return delivery(30); },
    }]);
    assert.equal(normalizations, 1, "Authority and publication must share one canonical serialization");
    const snapshot = createStore(path).read();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.acceptedThroughUpdateId, undefined);
    assert.deepEqual(snapshot.entries.map((entry) => entry.updateId), [10, 20, 30]);
    assert.ok(snapshot.entries.every((entry) => entry.preApprovalExcluded === undefined));
    assert.deepEqual(snapshot.entries[2]!.update, delivery(30));
    const published = publications;
    assert.throws(() => store.appendBatch([delivery(40, 8)]), (error) => isJournalError(error, "sender-denied"));
    current = false;
    assert.throws(() => store.appendBatch([delivery(40)]), /fixture stale receiver/);
    assert.equal(publications, published);
    current = true;
    failWrite = true;
    assert.throws(() => store.appendBatch([delivery(40)]), (error) => isJournalError(error, "io"));
    assert.deepEqual(store.read().entries.map((entry) => entry.updateId), [10, 20, 30]);
    assert.equal(held, false);
    assert.deepEqual(ledger.read().leases, []);
  });
});

test("Paired v1 denial does not read or repair retained journal evidence", async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const segmentPath = join(`${path}.segments`, "0000000000000001.json");
    await mkdir(`${path}.segments`);
    await writeFile(path, "{");
    await writeFile(segmentPath, "{}");
    let gates = 0;
    let publications = 0;
    let recoveries = 0;
    const store = createStore(path, {
      withSourceSerialization() { assert.fail("Sender denial must never fall back to lock-only serialization"); },
      withPairedAdmission() { gates++; assert.equal(existsSync(`${path}.transaction`), false); return { admitted: false }; },
      onPublicationBoundary: () => { publications++; },
      onRecovery: () => { recoveries++; },
    });
    assert.throws(() => store.appendBatch([{ update_id: 1 }]), (error) => isJournalError(error, "sender-denied"));
    assert.equal(gates, 1);
    assert.equal(publications, 0);
    assert.equal(recoveries, 0);
    assert.equal(await readFile(path, "utf8"), "{");
    assert.equal(await readFile(segmentPath, "utf8"), "{}");
    assert.equal(existsSync(join(dir, "recovery")), false);
    assert.throws(() => store.appendBatch([{ update_id: 2 }, { update_id: 1 }]), (error) => isJournalError(error, "invalid"));
    assert.equal(gates, 1, "Malformed batches must not reach source admission");
  });
});

test("Journal refuses mixed paired-only and exclusion admission modes", async () => {
  await withJournalTempDir(async ({ path }) => {
    assert.throws(() => createStore(path, {
      withPairingAdmission: (publish) => publish(true),
      withPairedAdmission: (_updates, publish) => ({ admitted: true, value: publish() }),
    }), /mutually exclusive/);
    assert.equal(existsSync(path), false);
  });
});

for (const liveSource of [false, true]) test(`Exclusion journal serializes Workspace/config/journal admission and preserves the veto after grant (live=${liveSource})`, { skip: liveSource && sourceTestOptions.skip }, async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const configPath = join(dir, "telegram.json");
    await writeFile(configPath, JSON.stringify({ profiles: { work: { botToken: "123:journal-secret" } } }));
    const config = createTelegramConfigStore({ agentDir: dir, configPath });
    await config.load();
    assert.equal(config.activateProfile("work"), true);
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "admission.json"), profileKey: "fixture:work",
      owner: { processId: process.pid, processBirthId: `${process.pid}:fixture-process` }, getProcessLiveness: () => "alive",
    });
    let workspaceHeld = false;
    let guardedPublications = 0;
    let rejectPublication = false;
    const options: Parameters<typeof createStore>[1] = {
      ...(liveSource ? { sourceAccess: { directory: dir, limits: sourceLimits } } : {}),
      workspaceAdmission: {
        acquireAdmission(...args) {
          assert.equal(existsSync(`${configPath}.transaction`), false);
          assert.equal(existsSync(`${path}.transaction`), false);
          const result = admission.acquireAdmission(...args);
          workspaceHeld = true;
          return result;
        },
        releaseAdmission(...args) {
          assert.equal(existsSync(`${configPath}.transaction`), false);
          assert.equal(existsSync(`${path}.transaction`), false);
          workspaceHeld = false;
          return admission.releaseAdmission(...args);
        },
      },
      withSourceSerialization: config.withSourceSerialization,
      withPairingAdmission(publish) {
        assert.equal(workspaceHeld, true);
        assert.equal(existsSync(`${path}.transaction`), false);
        return config.withPairingAdmission("work", identity.tokenSha256, publish);
      },
      onPublicationBoundary(boundary) {
        if (workspaceHeld) {
          assert.equal(existsSync(`${configPath}.transaction`), true);
          assert.equal(existsSync(`${path}.transaction`), true);
          guardedPublications++;
        }
        if (rejectPublication && boundary === "after-write-before-rename") throw new Error("fixture publication failure");
      },
    };
    const store = createStore(path, options);
    const first = { update_id: 1, preApprovalExcluded: false, message: { chat: { id: 100 } } };
    const second = { update_id: 2, preApprovalExcluded: true, message: { chat: { id: 100 } } };
    assert.deepEqual(store.appendBatch([first], 1).nonExcludedUpdateIds, []);
    const heldSnapshot = store.read();
    assert.equal(heldSnapshot.version, 2);
    assert.equal(heldSnapshot.entries[0]!.preApprovalExcluded, true);
    await config.persistAllowedUserId(42);
    const admitted = store.appendBatch([first, second], 2);
    assert.deepEqual(admitted.duplicateUpdateIds, [1]);
    assert.deepEqual(admitted.nonExcludedUpdateIds, [2], "Prepared IDs come from journal evidence, not payload flags or current config alone");
    assert.deepEqual(store.read().entries.map((entry) => entry.preApprovalExcluded), [true, false]);
    assert.equal(heldSnapshot.entries[0]!.preApprovalExcluded, true);
    assert.throws(() => store.markQueued({ queueKind: "prompt", receiptId: "excluded", sourceUpdateIds: [2, 1], owner: queueOwnerIdentity }),
      (error) => isJournalError(error, "pairing-evidence"));
    assert.equal(store.read().entries[1]!.state, "pending", "Mixed receipts must fail atomically");
    store.markQueued({ queueKind: "prompt", receiptId: "allowed", sourceUpdateIds: [2], owner: queueOwnerIdentity });
    store.markExecutionFailure({ updateId: 1, expectedAttemptCount: 0, failedAtMs: 1100,
      failureClass: "fixture", summary: "fixture", disposition: "retry-wait", nextRetryAtMs: 1200 });
    const failed = store.markExecutionFailure({ updateId: 1, expectedAttemptCount: 1, failedAtMs: 1200,
      failureClass: "fixture", summary: "fixture", disposition: "failed", terminalReason: "fixture" });
    store.applyOperatorDisposition({ updateId: 1, failureId: failed.entry.terminalFailureId!, action: "retry" });
    assert.deepEqual(createStore(path, options).read().entries.map((entry) => entry.preApprovalExcluded), [true, false]);
    store.removeCompleted([1]);
    const replay = store.appendBatch([first], 2);
    assert.deepEqual(replay.addedUpdateIds, [], "Settled pre-approval input must not be re-admitted after grant");
    assert.deepEqual(replay.nonExcludedUpdateIds, [], "Settled input cannot prepare grouping state");
    assert.deepEqual(store.read().entries.map((entry) => entry.updateId), [2]);
    rejectPublication = true;
    assert.throws(() => store.appendBatch([{ update_id: 3 }], 3), (error) => isJournalError(error, "io"));
    assert.equal(store.read().acceptedThroughUpdateId, 2);
    assert.ok(guardedPublications > 0);
    assert.equal(workspaceHeld, false);
    assert.deepEqual(admission.read().leases, []);
    assert.throws(() => store.appendBatch([{ update_id: 3 }]), (error) => isJournalError(error, "pairing-evidence"));
    assert.throws(() => createStore(path).read(), (error) => isJournalError(error, "unsupported-version"));
  });
});

test("Exclusion journal keeps evidence through segment compaction and fresh readers", async () => {
  await withJournalTempDir(async ({ path }) => {
    let excluded = true;
    const options: Parameters<typeof createStore>[1] = { withPairingAdmission: (publish) => publish(excluded) };
    const store = createStore(path, options);
    store.appendBatch([{ update_id: 1 }], 1);
    excluded = false;
    for (let cursor = 2; cursor <= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT + 1; cursor++) {
      store.appendBatch([], cursor);
    }
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.revision, TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT);
    assert.equal(persisted.entries[0].preApprovalExcluded, true);
    assert.equal(createStore(path, options).read().entries[0]!.preApprovalExcluded, true);
  });
});

test("Exclusion journal rejects malformed, changed, resurrected, and legacy evidence without repair", async () => {
  for (const scenario of ["missing-bit", "invalid-bit", "missing-cursor", "changed-bit", "excluded-queue", "resurrected", "invalid-json", "missing-snapshot", "legacy"] as const) {
    await withJournalTempDir(async ({ dir, path }) => {
      let publications = 0;
      let recoveries = 0;
      const options: Parameters<typeof createStore>[1] = {
        withPairingAdmission: (publish) => publish(scenario !== "excluded-queue"),
        onPublicationBoundary: () => { publications++; }, onRecovery: () => { recoveries++; },
      };
      const store = createStore(path, options);
      (scenario === "legacy" ? createStore(path) : store).appendBatch([{ update_id: 1 }], 1);
      let damagedPath = path;
      if (scenario !== "legacy") {
        if (scenario === "excluded-queue") {
          store.markQueued({ queueKind: "prompt", receiptId: "fixture", sourceUpdateIds: [1], owner: queueOwnerIdentity });
          damagedPath = join(`${path}.segments`, "0000000000000001.json");
        } else if (scenario === "resurrected") {
          store.removeCompleted([1]);
          store.appendBatch([{ update_id: 2 }], 2);
          damagedPath = join(`${path}.segments`, "0000000000000002.json");
        } else {
          store.markExecutionFailure({ updateId: 1, expectedAttemptCount: 0, failedAtMs: 1100,
            failureClass: "fixture", summary: "fixture", disposition: "retry-wait", nextRetryAtMs: 1200 });
          if (scenario === "changed-bit" || scenario === "invalid-bit") damagedPath = join(`${path}.segments`, "0000000000000001.json");
        }
        const damaged = JSON.parse(await readFile(damagedPath, "utf8"));
        const entry = (damaged.entries ?? damaged.upsertedEntries)[0];
        if (scenario === "missing-bit") delete entry.preApprovalExcluded;
        if (scenario === "invalid-bit") entry.preApprovalExcluded = "false";
        if (scenario === "missing-cursor") delete damaged.acceptedThroughUpdateId;
        if (scenario === "changed-bit") entry.preApprovalExcluded = false;
        if (scenario === "excluded-queue") entry.preApprovalExcluded = true;
        if (scenario === "resurrected") { entry.updateId = 1; entry.update.update_id = 1; entry.preApprovalExcluded = false; }
        await writeFile(damagedPath, scenario === "invalid-json" ? "{" : JSON.stringify(damaged));
      }
      if (scenario === "missing-snapshot") await rm(path);
      const files = [...(existsSync(path) ? [path] : []), ...((await readdir(`${path}.segments`).catch(() => [] as string[])).map((name) => join(`${path}.segments`, name)))];
      const original = await Promise.all(files.map((file) => readFile(file, "utf8")));
      publications = 0;
      const expectedCode = scenario === "legacy" ? "unsupported-version" : scenario === "invalid-json" ? "invalid" : "pairing-evidence";
      assert.throws(() => createStore(path, options).read(), (error) => isJournalError(error, expectedCode), scenario);
      assert.throws(() => store.appendBatch([{ update_id: 3 }], 3), (error) => isJournalError(error, expectedCode), scenario);
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), original, scenario);
      assert.equal(publications, 0, scenario);
      assert.equal(recoveries, 0, scenario);
      assert.equal(existsSync(join(dir, "recovery")), false, scenario);
    });
  }
});

test("Update journal runtime binding separates worker and process recovery identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-telegram-journal-binding-"));
  let profileName: string | undefined;
  let botToken: string | undefined;
  let botId: number | undefined;
  const resolveBinding = createTelegramUpdateJournalRuntimeBindingResolver({
    getProfileName: () => profileName,
    getBotToken: () => botToken,
    getBotId: () => botId,
    getJournalPath: (profile) =>
      join(directory, profile ? `inbox.${profile}.json` : "inbox.json"),
    getQueueRuntimeIdentity: () => ({
      instanceId: queueOwnerIdentity.instanceId,
      processId: queueOwnerIdentity.processId,
      processBirthId: queueOwnerIdentity.processBirthId,
    }),
  });
  try {
    assert.equal(resolveBinding(), undefined);
    botToken = "token-a";
    botId = 7;
    const first = resolveBinding()!;
    assert.equal(
      first.recoveryKey,
      createTelegramUpdateJournalBindingKey({
        path: join(directory, "inbox.json"),
        profileName: "default",
        botIdentity: createTelegramUpdateJournalBotIdentity({
          botToken: "token-a",
          botId: 7,
        }),
      }),
    );
    assert.equal(
      getTelegramUpdateJournalBindingPath(first.recoveryKey),
      join(directory, "inbox.json"),
    );
    assert.equal(getTelegramUpdateJournalBindingPath("profile-a"), undefined);
    assert.equal(first.journal.read().profile, "default");
    first.journal.appendBatch([{ update_id: 1 }]);
    assert.throws(
      () =>
        first.journal.markQueued({
          queueKind: "prompt",
          receiptId: "foreign-process",
          sourceUpdateIds: [1],
          owner: {
            ...queueOwnerIdentity,
            processId: process.pid + 1,
            processBirthId: `${process.pid + 1}:foreign`,
          },
        }),
      (error) => isJournalError(error, "conflict"),
    );

    botToken = "token-b";
    const rotated = resolveBinding()!;
    assert.notEqual(rotated.runtimeKey, first.runtimeKey);
    assert.equal(rotated.recoveryKey, first.recoveryKey);

    profileName = "work";
    const named = resolveBinding()!;
    assert.notEqual(named.runtimeKey, rotated.runtimeKey);
    assert.equal(
      named.recoveryKey,
      createTelegramUpdateJournalBindingKey({
        path: join(directory, "inbox.work.json"),
        profileName: "work",
        botIdentity: createTelegramUpdateJournalBotIdentity({
          botToken: "token-b",
          botId: 7,
        }),
      }),
    );
    assert.equal(named.journal.read().profile, "work");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Update journal binding runtime selects leader, follower, and recipient authority", async () => {
  await withJournalTempDir(async ({ dir }) => {
    let follower = false;
    let writerAdmissions = 0;
    const runtime = createTelegramUpdateJournalBindingRuntime({
      base: {
        getProfileName: () => "work",
        getBotToken: () => "token-a",
        getBotId: () => 7,
        withWriterAdmission(operation) {
          writerAdmissions += 1;
          return operation();
        },
        getQueueRuntimeIdentity: () => ({
          instanceId: "instance-a",
          processId: 42,
          processBirthId: "42:start:1",
        }),
      },
      getLeaderJournalPath: () => join(dir, "leader.json"),
      getFollowerJournalPath: (bindingKey) =>
        join(dir, `${bindingKey}.json`),
      getActiveFollowerBindingKey: () => "active-follower",
      isFollowerRegistered: () => follower,
    });
    const leader = runtime.resolveActive()!;
    assert.equal(getTelegramUpdateJournalBindingPath(leader.recoveryKey), join(dir, "leader.json"));
    leader.journal.appendBatch([{ update_id: 10 }]);
    follower = true;
    const activeFollower = runtime.resolveActive()!;
    assert.equal(getTelegramUpdateJournalBindingPath(activeFollower.recoveryKey),
      join(dir, "active-follower.json"));
    activeFollower.journal.appendBatch([{ update_id: 11 }]);
    const recipient = runtime.createRecipientResolver("recipient")()!;
    assert.equal(
      getTelegramUpdateJournalBindingPath(recipient.recoveryKey),
      join(dir, "recipient.json"),
    );
    recipient.journal.appendBatch([{ update_id: 1 }]);
    assert.equal(
      recipient.journal.markQueued({
        queueKind: "prompt",
        receiptId: "recipient-receipt",
        sourceUpdateIds: [1],
        owner: {
          instanceId: "recipient-instance",
          processId: 99,
          processBirthId: "99:start:1",
          sessionGeneration: 1,
        },
      }).queueOwner?.instanceId,
      "recipient-instance",
    );
    const discovered = runtime.createPathResolver(
      join(dir, "follower-inbox-0123456789abcdef.work.json"),
    )()!;
    assert.equal(
      getTelegramUpdateJournalBindingPath(discovered.recoveryKey),
      join(dir, "follower-inbox-0123456789abcdef.work.json"),
    );
    discovered.journal.appendBatch([{ update_id: 12 }]);
    assert.equal(writerAdmissions, 5);
    assert.equal(
      runtime.getActiveRecoveryKey(),
      runtime.resolveFollower()!.recoveryKey,
    );
  });
});

test("Update journal bot identity is deterministic without persisting tokens", () => {
  const first = createTelegramUpdateJournalBotIdentity({
    botToken: "123:abc",
    botId: 7,
  });
  const second = createTelegramUpdateJournalBotIdentity({
    botToken: "123:abc",
    botId: 7,
  });
  assert.deepEqual(first, second);
  assert.equal(first.botId, 7);
  assert.match(first.tokenSha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.tokenSha256.includes("123:abc"), false);
  assert.throws(
    () => createTelegramUpdateJournalBotIdentity({ botToken: "" }),
    /configured bot token/u,
  );
  assert.throws(
    () =>
      createTelegramUpdateJournalBotIdentity({
        botToken: "123:abc",
        botId: 0,
      }),
    /safe integer/u,
  );
});

test("Update journal receipt scope is profile-bound and stable across proven token rotation", () => {
  const first = createTelegramUpdateJournalReceiptScope({
    profileName: "work",
    botIdentity: createTelegramUpdateJournalBotIdentity({
      botToken: "token-a",
      botId: 42,
    }),
  });
  const rotated = createTelegramUpdateJournalReceiptScope({
    profileName: "work",
    botIdentity: createTelegramUpdateJournalBotIdentity({
      botToken: "token-b",
      botId: 42,
    }),
  });
  const otherProfile = createTelegramUpdateJournalReceiptScope({
    profileName: "other",
    botIdentity: createTelegramUpdateJournalBotIdentity({
      botToken: "token-b",
      botId: 42,
    }),
  });
  const unknownBot = createTelegramUpdateJournalReceiptScope({
    profileName: "work",
    botIdentity: createTelegramUpdateJournalBotIdentity({
      botToken: "token-a",
    }),
  });

  assert.equal(first, rotated);
  assert.notEqual(first, otherProfile);
  assert.notEqual(first, unknownBot);
  assert.equal(first.includes("token-a"), false);
});

test("Update journal receipt scope resolver freezes same-transport bot enrichment", () => {
  let botId: number | undefined;
  let botToken = "token-a";
  const resolve = createTelegramUpdateJournalReceiptScopeResolver({
    getProfileName: () => "work",
    getBotToken: () => botToken,
    getBotId: () => botId,
  });
  const initial = resolve();
  botId = 42;
  assert.equal(resolve(), initial);
  botToken = "token-b";
  const rotated = resolve();
  assert.notEqual(rotated, initial);
  assert.equal(
    rotated,
    createTelegramUpdateJournalReceiptScope({
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken,
        botId,
      }),
    }),
  );
});

test("Update journal derives conservative Workspace admission scopes", () => {
  assert.deepEqual(
    getTelegramUpdateJournalAdmissionScopes([
      {
        update_id: 1,
        message: { chat: { id: 100 }, message_thread_id: 10 },
      },
      {
        update_id: 2,
        callback_query: {
          message: { chat: { id: 200 }, message_thread_id: 20 },
        },
      },
    ]),
    [
      { kind: "target", target: { chatId: 100, threadId: 10 } },
      { kind: "target", target: { chatId: 200, threadId: 20 } },
    ],
  );
  assert.deepEqual(
    getTelegramUpdateJournalAdmissionScopes([
      {
        update_id: 3,
        message: { chat: { id: 100 }, message_thread_id: 10 },
      },
      { update_id: 4, edited_message: { chat: { id: 100 } } },
    ]),
    [{ kind: "chat", chatId: 100 }],
  );
  assert.deepEqual(
    getTelegramUpdateJournalAdmissionScopes([
      { update_id: 5, callback_query: { inline_message_id: "opaque" } },
    ]),
    [{ kind: "profile" }],
  );
  assert.deepEqual(
    getTelegramUpdateJournalAdmissionScopes([
      {
        update_id: 6,
        message: { chat: { id: 100 }, message_thread_id: "invalid" },
      },
    ]),
    [{ kind: "profile" }],
  );
  assert.deepEqual(getTelegramUpdateJournalAdmissionScopes([]), [
    { kind: "profile" },
  ]);
});

test("Update journal holds Workspace admission through publication and releases it", async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const admissionPath = join(dir, "workspace-admission.json");
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: admissionPath,
      profileKey: "profile:journal",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:journal-admission-test`,
      },
      getProcessLiveness: () => "alive",
    });
    let observedLease = false;
    let observedBlockedFence = false;
    const store = createStore(path, {
      workspaceAdmission: admission,
      onPublicationBoundary(boundary) {
        if (boundary !== "after-write-before-rename") return;
        const snapshot = admission.read();
        observedLease = snapshot.leases.some(
          (lease) =>
            lease.operationKind === "journal.append" &&
            lease.scope.kind === "target" &&
            lease.scope.target.chatId === 100 &&
            lease.scope.target.threadId === 10,
        );
        observedBlockedFence =
          admission.acquireRetirementFence({
            operationId: "journal-boundary-fence",
            retirementIntentId: "journal-boundary-intent",
            bindingKey: "journal-boundary-binding",
            slot: "A",
            target: { chatId: 100, threadId: 10 },
            leaderEpoch: 1,
            retirementRequestedAtMs: 1,
          }).kind === "blocked";
      },
    });
    store.appendBatch([
      {
        update_id: 1,
        message: { chat: { id: 100 }, message_thread_id: 10 },
      },
    ]);
    assert.equal(observedLease, true);
    assert.equal(observedBlockedFence, true);
    assert.deepEqual(admission.read().leases, []);
  });
});

test("Update journal rejects fenced targets and releases admission after failure", async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "workspace-admission.json"),
      profileKey: "profile:journal",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:journal-admission-test`,
      },
      getProcessLiveness: () => "alive",
    });
    const fence = admission.acquireRetirementFence({
      operationId: "active-retirement",
      retirementIntentId: "active-intent",
      bindingKey: "active-binding",
      slot: "A",
      target: { chatId: 200, threadId: 20 },
      leaderEpoch: 1,
      retirementRequestedAtMs: 1,
    });
    assert.equal(fence.kind, "acquired");
    const blocked = createStore(path, { workspaceAdmission: admission });
    assert.throws(
      () =>
        blocked.appendBatch([
          {
            update_id: 1,
            message: { chat: { id: 100 }, message_thread_id: 10 },
          },
          {
            update_id: 2,
            message: { chat: { id: 200 }, message_thread_id: 20 },
          },
        ]),
      (error) =>
        error instanceof TelegramWorkspaceAdmissionError &&
        error.code === "admission-blocked",
    );
    assert.equal(admission.read().leases.length, 0);
    assert.equal(existsSync(path), false);

    if (fence.kind === "acquired") {
      assert.equal(admission.releaseUnissuedRetirementFence(fence.fence), true);
    }
    const constrained = createStore(path, {
      workspaceAdmission: admission,
      maxEntries: 1,
    });
    assert.throws(
      () =>
        constrained.appendBatch([
          {
            update_id: 1,
            message: { chat: { id: 100 }, message_thread_id: 10 },
          },
          {
            update_id: 2,
            message: { chat: { id: 100 }, message_thread_id: 10 },
          },
        ]),
      (error) => isJournalError(error, "capacity"),
    );
    assert.deepEqual(admission.read().leases, []);
  });
});

test("Update journal cursor-only admission is profile-wide", async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "workspace-admission.json"),
      profileKey: "profile:journal",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:journal-admission-test`,
      },
      getProcessLiveness: () => "alive",
    });
    const fence = admission.acquireRetirementFence({
      operationId: "other-target-retirement",
      retirementIntentId: "other-target-intent",
      bindingKey: "other-target-binding",
      slot: "B",
      target: { chatId: 999, threadId: 99 },
      leaderEpoch: 1,
      retirementRequestedAtMs: 1,
    });
    assert.equal(fence.kind, "acquired");
    const store = createStore(path, { workspaceAdmission: admission });
    assert.throws(
      () => store.appendBatch([], 1),
      (error) =>
        error instanceof TelegramWorkspaceAdmissionError &&
        error.code === "admission-blocked",
    );
    assert.equal(existsSync(path), false);
  });
});

test("Update journal appends batches, deduplicates exact replay, and removes entries", async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const store = createStore(path, { nowMs: 1_234 });
    assert.deepEqual(store.read(), {
      version: 1,
      profile: "work",
      botIdentity: identity,
      entries: [],
      exists: false,
      serializedBytes: 0,
    });

    const updates: TelegramJournaledUpdate[] = [
      { update_id: 10, message: { text: "first" } },
      { update_id: 11, callback_query: { data: "next" } },
    ];
    const appended = store.appendBatch(updates);
    assert.deepEqual(appended.addedUpdateIds, [10, 11]);
    assert.deepEqual(appended.duplicateUpdateIds, []);
    assert.equal(appended.entryCount, 2);
    assert.deepEqual(appended.nonExcludedUpdateIds, [10, 11]);
    assert.ok(appended.serializedBytes > 0);

    const snapshot = store.read();
    assert.equal(snapshot.exists, true);
    assert.deepEqual(
      snapshot.entries.map((entry) => ({
        updateId: entry.updateId,
        admittedAtMs: entry.admittedAtMs,
        state: entry.state,
      })),
      [
        { updateId: 10, admittedAtMs: 1_234, state: "pending" },
        { updateId: 11, admittedAtMs: 1_234, state: "pending" },
      ],
    );
    snapshot.entries[0]!.update.message = { text: "mutated snapshot" };
    assert.deepEqual(store.read().entries[0]?.update, updates[0]);

    const beforeReplay = await readFile(path, "utf8");
    const replayed = store.appendBatch([
      { message: { text: "first" }, update_id: 10 },
      { callback_query: { data: "next" }, update_id: 11 },
    ]);
    assert.deepEqual(replayed.addedUpdateIds, []);
    assert.deepEqual(replayed.duplicateUpdateIds, [10, 11]);
    assert.deepEqual(replayed.nonExcludedUpdateIds, [10, 11]);
    assert.equal(await readFile(path, "utf8"), beforeReplay);
    assert.equal((await readFile(path, "utf8")).includes("journal-secret"), false);

    const removed = store.removeCompleted([10, 999]);
    assert.deepEqual(removed.removedUpdateIds, [10]);
    assert.deepEqual(
      store.read().entries.map((entry) => entry.updateId),
      [11],
    );
    assert.deepEqual((await readdir(dir)).sort(), [
      "inbox.work.json",
      "inbox.work.json.segments",
    ]);
    assert.deepEqual(await readdir(`${path}.segments`), [
      "0000000000000001.json",
    ]);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  });
});

test("Update journal publishes and retains a monotonic admission cursor with its batch", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    const appended = store.appendBatch(
      [{ update_id: 10 }, { update_id: 11 }],
      11,
    );
    assert.deepEqual(appended.addedUpdateIds, [10, 11]);
    assert.equal(store.read().acceptedThroughUpdateId, 11);

    store.removeCompleted([10, 11]);
    const settled = store.read();
    assert.deepEqual(settled.entries, []);
    assert.equal(settled.acceptedThroughUpdateId, 11);

    assert.throws(
      () => store.appendBatch([{ update_id: 12 }], 11),
      (error) => isJournalError(error, "invalid"),
    );
    assert.throws(
      () => store.appendBatch([], 10),
      (error) => isJournalError(error, "conflict"),
    );
    store.appendBatch([], 12);
    assert.equal(store.read().acceptedThroughUpdateId, 12);
  });
});

test("Update journal accepts revision-zero snapshots and publishes private atomic segments", async () => {
  await withJournalTempDir(async ({ dir, path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    assert.equal(store.read().revision, undefined);
    const segment = {
      version: 1 as const,
      revision: 1,
      previousRevision: 0,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [],
      removedUpdateIds: [1],
    };
    const published = publishTelegramUpdateJournalSegment(path, segment);
    assert.equal(published.revision, 1);
    assert.ok(published.serializedBytes > 0);
    assert.equal(
      published.path,
      join(dir, "inbox.work.json.segments", "0000000000000001.json"),
    );
    assert.equal(
      await readFile(published.path, "utf8"),
      `${JSON.stringify(segment, null, 2)}\n`,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(published.path)).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      publishTelegramUpdateJournalSegment(path, segment),
      published,
    );
    const reconstructed = store.read();
    assert.equal(reconstructed.revision, 1);
    assert.deepEqual(reconstructed.entries, []);
    assert.throws(
      () =>
        publishTelegramUpdateJournalSegment(path, {
          ...segment,
          revision: 3,
          previousRevision: 2,
        }),
      /revision has a gap/u,
    );
    assert.throws(
      () =>
        publishTelegramUpdateJournalSegment(path, {
          ...segment,
          removedUpdateIds: [],
        }),
      /revision conflicts/u,
    );
  });
});

test("Update journal reconstructs ordered segments, rejects foreign identity, and resets gaps", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 1,
      previousRevision: 0,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [
        {
          updateId: 2,
          update: { update_id: 2 },
          admittedAtMs: 2,
          state: "pending",
        },
      ],
      removedUpdateIds: [1],
    });
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 2,
      previousRevision: 1,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [],
      removedUpdateIds: [2],
    });
    assert.deepEqual(store.read().entries, []);
    assert.equal(store.read().revision, 2);

    const segmentPath = `${path}.segments/0000000000000002.json`;
    const source = JSON.parse(await readFile(segmentPath, "utf8")) as Record<
      string,
      unknown
    >;
    source.profile = "foreign";
    await writeFile(segmentPath, `${JSON.stringify(source, null, 2)}\n`);
    assert.throws(
      () => store.read(),
      (error: unknown) =>
        error instanceof TelegramUpdateJournalError &&
        error.code === "identity-mismatch",
    );

    source.profile = "work";
    source.previousRevision = 0;
    await writeFile(segmentPath, `${JSON.stringify(source, null, 2)}\n`);
    const reset = store.read();
    assert.equal(reset.revision, undefined);
    assert.deepEqual(reset.entries, []);
  });
});

test("Unsupported journal schemas remain byte-preserved even behind recoverable damage", async () => {
  for (const scenario of ["snapshot", "segment", "damaged-snapshot", "revisionless-tail", "missing-snapshot"] as const) {
    await withJournalTempDir(async ({ dir, path }) => {
      const recoveries: unknown[] = [];
      let publications = 0;
      const store = createStore(path, { onRecovery: (event) => recoveries.push(event),
        onPublicationBoundary: () => { publications++; } });
      store.appendBatch([{ update_id: 1 }], 1);
      const snapshot = JSON.parse(await readFile(path, "utf8"));
      delete snapshot.revision;
      if (scenario === "snapshot") {
        snapshot.version = 2;
        snapshot.futureRequiredField = true;
      }
      await writeFile(path, scenario === "damaged-snapshot" ? "{" : JSON.stringify(snapshot));
      if (scenario === "missing-snapshot") await rm(path);
      await mkdir(`${path}.segments`, { recursive: true });
      const segment = { version: 1, revision: 2, previousRevision: 1,
        profile: "work", botIdentity: identity, upsertedEntries: [], removedUpdateIds: [] };
      const firstPath = join(`${path}.segments`, "0000000000000002.json");
      const first = JSON.stringify(scenario === "segment" ? { ...segment, version: 2, futureRequiredField: true } : segment);
      await writeFile(firstPath, first);
      const tailPath = join(`${path}.segments`, "0000000000000003.json");
      const tail = JSON.stringify({ ...segment, revision: 3, previousRevision: 2, version: 2, futureRequiredField: true });
      await writeFile(tailPath, tail);
      const before = existsSync(path) ? await readFile(path, "utf8") : undefined;
      publications = 0;
      for (const operation of [() => store.read(), () => store.appendBatch([{ update_id: 99 }], 99)]) {
        assert.throws(operation, (error) => isJournalError(error, "unsupported-version"), scenario);
        assert.equal(existsSync(path) ? await readFile(path, "utf8") : undefined, before, scenario);
        assert.equal(await readFile(firstPath, "utf8"), first);
        assert.equal(await readFile(tailPath, "utf8"), tail);
        assert.equal(existsSync(join(dir, "recovery")), false);
      }
      assert.deepEqual(recoveries, []);
      assert.equal(publications, 0);
    });
  }
});

test("Journal recovery identity codecs keep their fixed v1 wire encoding", () => {
  const receiptScope = '{"version":1,"profile":"work","bot":{"botId":42}}';
  assert.equal(createTelegramUpdateJournalReceiptScope({ profileName: "work", botIdentity: identity }), receiptScope);
  const binding = createTelegramUpdateJournalBindingKey({ path: "/fixture/inbox.json", profileName: "work", botIdentity: identity });
  assert.equal(binding, JSON.stringify({ version: 1, path: "/fixture/inbox.json", receiptScope }));
  assert.equal(getTelegramUpdateJournalBindingPath(binding), "/fixture/inbox.json");
  assert.equal(getTelegramUpdateJournalBindingPath(JSON.stringify({ version: 2, path: "/fixture/inbox.json", receiptScope })), undefined);
  const tokenSha256 = "a".repeat(64);
  assert.equal(createTelegramUpdateJournalReceiptScope({ botIdentity: { tokenSha256 } }),
    JSON.stringify({ version: 1, profile: "default", bot: { tokenSha256 } }));
});

test("Update journal repairs a revisionless snapshot from a later segment tail", async () => {
  await withJournalTempDir(async ({ path }) => {
    const recoveryEvents: Array<{ kind: "repaired" | "reset"; revision?: number }> = [];
    const store = createStore(path, {
      onRecovery: (event) => recoveryEvents.push(event),
    });
    store.appendBatch([{ update_id: 1 }]);
    await mkdir(`${path}.segments`);
    await writeFile(
      join(`${path}.segments`, "0000000000000002.json"),
      `${JSON.stringify(
        {
          version: 1,
          revision: 2,
          previousRevision: 1,
          profile: "work",
          botIdentity: identity,
          upsertedEntries: [],
          removedUpdateIds: [1],
        },
        null,
        2,
      )}\n`,
    );

    const repaired = store.read();
    assert.equal(repaired.revision, 2);
    assert.deepEqual(repaired.entries, []);
    assert.equal(recoveryEvents[0]?.kind, "repaired");
    assert.equal(recoveryEvents[0]?.revision, 2);
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      revision?: number;
    };
    assert.equal(snapshot.revision, 1);
  });
});

test("Update journal quarantines and resets an uncertain orphaned segment history", async () => {
  await withJournalTempDir(async ({ path }) => {
    const recoveryEvents: Array<{
      kind: "repaired" | "reset";
      quarantinePath?: string;
      reason: string;
    }> = [];
    const store = createStore(path, {
      onRecovery: (event) => recoveryEvents.push(event),
    });
    store.appendBatch([{ update_id: 1 }]);
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 1,
      previousRevision: 0,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [],
      removedUpdateIds: [],
    });
    await rm(path);

    const reset = store.read();
    assert.equal(reset.revision, undefined);
    assert.deepEqual(reset.entries, []);
    assert.equal(recoveryEvents.length, 1);
    assert.equal(recoveryEvents[0]?.kind, "reset");
    assert.match(recoveryEvents[0]?.reason ?? "", /missing while .*segments/u);
    const quarantinePath = recoveryEvents[0]?.quarantinePath;
    assert.ok(quarantinePath);
    assert.deepEqual(await readdir(quarantinePath), [
      "inbox.work.json.segments",
    ]);
    assert.deepEqual(
      await readdir(join(quarantinePath, "inbox.work.json.segments")),
      ["0000000000000001.json"],
    );
    await assert.rejects(() => stat(`${path}.segments`), /ENOENT/u);
    assert.deepEqual(store.appendBatch([{ update_id: 2 }]).addedUpdateIds, [2]);
  });
});

test("Update journal restores orphaned segments when reset publication fails", async () => {
  await withJournalTempDir(async ({ path }) => {
    const seed = createStore(path);
    seed.appendBatch([{ update_id: 1 }]);
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 1,
      previousRevision: 0,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [],
      removedUpdateIds: [],
    });
    await rm(path);
    const recovering = createStore(path, {
      onPublicationBoundary: (boundary, publicationPath) => {
        if (boundary === "before-write" && publicationPath === path) {
          throw new Error("reset publication blocked");
        }
      },
    });

    assert.throws(() => recovering.read(), /mutation failed/u);
    await assert.rejects(() => stat(path), /ENOENT/u);
    assert.deepEqual(await readdir(`${path}.segments`), [
      "0000000000000001.json",
    ]);
    assert.deepEqual(seed.read().entries, []);
  });
});

test("Update journal repairs a cleanup-orphaned empty segment history", async () => {
  await withJournalTempDir(async ({ path }) => {
    const recoveryEvents: Array<{ kind: "repaired" | "reset"; revision?: number }> = [];
    const store = createStore(path, {
      onRecovery: (event) => recoveryEvents.push(event),
    });
    store.appendBatch([{ update_id: 1 }]);
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 1,
      previousRevision: 0,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [],
      removedUpdateIds: [1],
    });
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 2,
      previousRevision: 1,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [
        {
          updateId: 2,
          update: { update_id: 2 },
          admittedAtMs: 2,
          state: "pending",
        },
      ],
      removedUpdateIds: [],
    });
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 3,
      previousRevision: 2,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [],
      removedUpdateIds: [2],
    });
    await rm(path);

    const recovered = store.read();
    assert.equal(recovered.revision, 3);
    assert.deepEqual(recovered.entries, []);
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      revision?: number;
      entries: unknown[];
    };
    assert.equal(snapshot.revision, 3);
    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(recoveryEvents, [{
      kind: "repaired",
      revision: 3,
      path,
      reason: "Recovered a missing snapshot from a complete empty segment history.",
    }]);
    assert.deepEqual((await readdir(`${path}.segments`)).sort(), [
      "0000000000000001.json",
      "0000000000000002.json",
      "0000000000000003.json",
    ]);
  });
});

test("Update journal recovers the admission cursor from a cleanup-orphaned empty segment chain", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }], 1);
    store.removeCompleted([1]);
    await rm(path);

    const recovered = store.read();
    assert.equal(recovered.revision, 1);
    assert.deepEqual(recovered.entries, []);
    assert.equal(recovered.acceptedThroughUpdateId, 1);
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      acceptedThroughUpdateId?: number;
    };
    assert.equal(snapshot.acceptedThroughUpdateId, 1);
  });
});

test("Update journal compacts at the segment-count threshold without losing authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }], 1);
    for (
      let revision = 1;
      revision < TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT;
      revision += 1
    ) {
      const removedUpdateIds = revision % 2 === 1 ? [1] : [];
      const upsertedEntries =
        revision % 2 === 0
          ? [
              {
                updateId: 1,
                update: { update_id: 1 },
                admittedAtMs: 1,
                state: "pending" as const,
              },
            ]
          : [];
      publishTelegramUpdateJournalSegment(path, {
        version: 1,
        revision,
        previousRevision: revision - 1,
        profile: "work",
        botIdentity: identity,
        upsertedEntries,
        removedUpdateIds,
      });
    }
    assert.equal(
      (await readdir(`${path}.segments`)).length,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT - 1,
    );
    const before = store.read();
    assert.equal(
      before.revision,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT - 1,
    );
    assert.deepEqual(before.entries, []);
    assert.equal(before.acceptedThroughUpdateId, 1);

    store.appendBatch([{ update_id: 2 }], 2);
    const compacted = store.read();
    assert.equal(
      compacted.revision,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT,
    );
    assert.deepEqual(
      compacted.entries.map((entry) => entry.updateId),
      [2],
    );
    assert.equal(compacted.acceptedThroughUpdateId, 2);
    await assert.rejects(() => readdir(`${path}.segments`), /ENOENT/u);
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      revision?: number;
      acceptedThroughUpdateId?: number;
      entries: Array<{ updateId: number }>;
    };
    assert.equal(
      snapshot.revision,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT,
    );
    assert.equal(snapshot.acceptedThroughUpdateId, 2);
    assert.deepEqual(snapshot.entries.map((entry) => entry.updateId), [2]);
  });
});

test("Update journal compacts at the segment-byte threshold", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    const payload = "x".repeat(350_000);
    let revision = 0;
    let segmentBytes = 0;
    while (segmentBytes < TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES) {
      revision += 1;
      const published = publishTelegramUpdateJournalSegment(path, {
        version: 1,
        revision,
        previousRevision: revision - 1,
        profile: "work",
        botIdentity: identity,
        upsertedEntries: [
          {
            updateId: 1,
            update: { update_id: 1, message: { text: `${revision}:${payload}` } },
            admittedAtMs: 1,
            state: "pending",
          },
        ],
        removedUpdateIds: [],
      });
      segmentBytes += published.serializedBytes;
    }
    assert.ok(
      revision < TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT,
      "byte threshold must trigger before the count threshold",
    );

    store.appendBatch([{ update_id: 2 }]);
    const compacted = store.read();
    assert.equal(compacted.revision, revision + 1);
    assert.deepEqual(
      compacted.entries.map((entry) => entry.updateId),
      [1, 2],
    );
    await assert.rejects(() => readdir(`${path}.segments`), /ENOENT/u);
  });
});

test("Update journal retains authority when compaction cleanup is interrupted", async () => {
  await withJournalTempDir(async ({ path }) => {
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 1,
          revision: 1,
          profile: "work",
          botIdentity: identity,
          entries: [
            {
              updateId: 1,
              update: { update_id: 1 },
              admittedAtMs: 1,
              state: "pending",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(`${path}.segments`);
    await mkdir(join(`${path}.segments`, "0000000000000001.json"));
    for (
      let revision = 2;
      revision <= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT + 1;
      revision += 1
    ) {
      await writeFile(
        join(
          `${path}.segments`,
          `${String(revision).padStart(16, "0")}.json`,
        ),
        `${JSON.stringify({
          version: 1,
          revision,
          previousRevision: revision - 1,
          profile: "work",
          botIdentity: identity,
          upsertedEntries: [],
          removedUpdateIds: [],
        })}\n`,
      );
    }

    const store = createStore(path);
    store.appendBatch([{ update_id: 2 }]);
    const reconstructed = store.read();
    assert.equal(
      reconstructed.revision,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT + 2,
    );
    assert.deepEqual(
      reconstructed.entries.map((entry) => entry.updateId),
      [1, 2],
    );
    assert.equal(
      (await readdir(`${path}.segments`)).length,
      1,
      "failed unlink cleanup leaves only the redundant undeletable revision",
    );
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      revision?: number;
      entries: Array<{ updateId: number }>;
    };
    assert.equal(
      snapshot.revision,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT + 2,
    );
    assert.deepEqual(snapshot.entries.map((entry) => entry.updateId), [1, 2]);
  });
});

test("Update journal compaction thresholds exclude redundant old segments", async () => {
  await withJournalTempDir(async ({ path }) => {
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 1,
          revision: TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT - 1,
          profile: "work",
          botIdentity: identity,
          entries: [],
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(`${path}.segments`);
    for (
      let revision = 1;
      revision < TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT;
      revision += 1
    ) {
      await mkdir(
        join(`${path}.segments`, `${String(revision).padStart(16, "0")}.json`),
      );
    }
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    const rawSnapshot = JSON.parse(await readFile(path, "utf8")) as {
      revision?: number;
    };
    assert.equal(
      rawSnapshot.revision,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT - 1,
      "one unapplied segment must not compact because redundant cleanup remains",
    );
    assert.equal(
      store.read().revision,
      TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT,
    );
    assert.ok(
      (await readdir(`${path}.segments`)).includes(
        `${String(TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT).padStart(16, "0")}.json`,
      ),
    );
  });
});

test("Update journal bounds aggregate unapplied segment bytes", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    const payload = "x".repeat(1_000);
    for (let revision = 1; revision <= 2; revision += 1) {
      publishTelegramUpdateJournalSegment(path, {
        version: 1,
        revision,
        previousRevision: revision - 1,
        profile: "work",
        botIdentity: identity,
        upsertedEntries: [
          {
            updateId: 1,
            update: { update_id: 1, message: { text: `${revision}:${payload}` } },
            admittedAtMs: 1,
            state: "pending",
          },
        ],
        removedUpdateIds: [],
      });
    }
    const segmentSizes = await Promise.all(
      (await readdir(`${path}.segments`)).map(async (name) =>
        stat(join(`${path}.segments`, name)),
      ),
    );
    const largestSegment = Math.max(...segmentSizes.map((entry) => entry.size));
    const aggregateBytes = segmentSizes.reduce(
      (total, entry) => total + entry.size,
      0,
    );
    const maxBytes = largestSegment + 100;
    assert.ok(aggregateBytes > maxBytes);
    const constrained = createStore(path, { maxBytes });
    assert.throws(
      () => constrained.read(),
      (error: unknown) =>
        error instanceof TelegramUpdateJournalError &&
        error.code === "capacity" &&
        /unapplied-segment limit/u.test(error.message),
    );
    assert.equal(store.read().revision, 2);
  });
});

test("Update journal accepts a newer snapshot with a redundant old segment", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    publishTelegramUpdateJournalSegment(path, {
      version: 1,
      revision: 1,
      previousRevision: 0,
      profile: "work",
      botIdentity: identity,
      upsertedEntries: [],
      removedUpdateIds: [1],
    });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 1,
          revision: 1,
          profile: "work",
          botIdentity: identity,
          entries: [],
        },
        null,
        2,
      )}\n`,
    );

    const reconstructed = store.read();
    assert.equal(reconstructed.revision, 1);
    assert.deepEqual(reconstructed.entries, []);
    assert.deepEqual(await readdir(`${path}.segments`), [
      "0000000000000001.json",
    ]);
    store.appendBatch([{ update_id: 2 }]);
    assert.equal(store.read().revision, 2);
    assert.deepEqual(
      store.read().entries.map((entry) => entry.updateId),
      [2],
    );
  });
});

test("Update journal publication interruption preserves prior authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    const snapshotBefore = await readFile(path, "utf8");

    for (const boundary of [
      "before-write",
      "after-write-before-rename",
    ] as const) {
      const interrupted = createStore(path, {
        onPublicationBoundary(candidate, publicationPath) {
          if (
            candidate === boundary &&
            publicationPath.endsWith("0000000000000001.json")
          ) {
            throw new Error(`interrupted:${boundary}`);
          }
        },
      });
      assert.throws(
        () => interrupted.removeCompleted([1]),
        (error: unknown) =>
          error instanceof TelegramUpdateJournalError &&
          (error.cause as Error | undefined)?.message ===
            `interrupted:${boundary}`,
      );
      assert.equal(await readFile(path, "utf8"), snapshotBefore);
      assert.deepEqual(await readdir(`${path}.segments`), []);
      assert.deepEqual(
        store.read().entries.map((entry) => entry.updateId),
        [1],
      );
    }
  });
});

test("Update journal cursor publication interruption retains the prior batch and cursor", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }], 1);
    for (const boundary of [
      "before-write",
      "after-write-before-rename",
    ] as const) {
      const interrupted = createStore(path, {
        onPublicationBoundary(candidate, publicationPath) {
          if (
            candidate === boundary &&
            publicationPath.endsWith("0000000000000001.json")
          ) {
            throw new Error(`cursor-interrupted:${boundary}`);
          }
        },
      });
      assert.throws(
        () => interrupted.appendBatch([{ update_id: 2 }], 2),
        (error: unknown) =>
          error instanceof TelegramUpdateJournalError &&
          (error.cause as Error | undefined)?.message ===
            `cursor-interrupted:${boundary}`,
      );
      const retained = store.read();
      assert.equal(retained.acceptedThroughUpdateId, 1);
      assert.deepEqual(retained.entries.map((entry) => entry.updateId), [1]);
    }
  });
});

test("Update journal queue and completion interruption retain prior authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const owner = { ...queueOwnerIdentity };
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    let operation: "queue" | "completion" = "queue";
    const interrupted = createStore(path, {
      onPublicationBoundary(boundary, publicationPath) {
        if (
          boundary === "after-write-before-rename" &&
          /\.segments[\\/]/u.test(publicationPath)
        ) {
          throw new Error(`interrupted:${operation}`);
        }
      },
    });
    assert.throws(
      () =>
        interrupted.markQueued({
          queueKind: "prompt",
          receiptId: "publication-receipt",
          sourceUpdateIds: [1],
          owner,
        }),
      (error: unknown) =>
        error instanceof TelegramUpdateJournalError &&
        (error.cause as Error | undefined)?.message === "interrupted:queue",
    );
    assert.equal(store.read().entries[0]?.state, "pending");

    const queued = store.markQueued({
      queueKind: "prompt",
      receiptId: "publication-receipt",
      sourceUpdateIds: [1],
      owner,
    });
    operation = "completion";
    assert.throws(
      () =>
        interrupted.completeQueued([
          {
            queueKind: "prompt",
            receiptId: "publication-receipt",
            sourceUpdateIds: [1],
            queueOwner: queued.queueOwner!,
          },
        ]),
      (error: unknown) =>
        error instanceof TelegramUpdateJournalError &&
        (error.cause as Error | undefined)?.message ===
          "interrupted:completion",
    );
    assert.equal(store.read().entries[0]?.state, "queued");
    assert.deepEqual(store.read().entries[0]?.queueOwner, queued.queueOwner);
  });
});

test("Update journal capacity rejection preserves exact snapshot and segment bytes", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    store.markExecutionFailure({
      updateId: 1,
      expectedAttemptCount: 0,
      failedAtMs: 1,
      failureClass: "retry",
      summary: "short",
      disposition: "retry-wait",
      nextRetryAtMs: 2,
    });
    const snapshotBefore = await readFile(path, "utf8");
    const segmentDirectory = `${path}.segments`;
    const segmentNamesBefore = await readdir(segmentDirectory);
    const segmentsBefore = await Promise.all(
      segmentNamesBefore.map((name) =>
        readFile(join(segmentDirectory, name), "utf8"),
      ),
    );
    const currentBytes = store.read().serializedBytes;
    const constrained = createStore(path, { maxBytes: currentBytes + 1 });

    assert.throws(
      () =>
        constrained.markExecutionFailure({
          updateId: 1,
          expectedAttemptCount: 1,
          failedAtMs: 2,
          failureClass: "terminal",
          summary: "x".repeat(512),
          disposition: "failed",
          terminalReason: "capacity-boundary",
        }),
      (error: unknown) =>
        error instanceof TelegramUpdateJournalError && error.code === "capacity",
    );
    assert.equal(await readFile(path, "utf8"), snapshotBefore);
    assert.deepEqual(await readdir(segmentDirectory), segmentNamesBefore);
    assert.deepEqual(
      await Promise.all(
        segmentNamesBefore.map((name) =>
          readFile(join(segmentDirectory, name), "utf8"),
        ),
      ),
      segmentsBefore,
    );
    assert.equal(store.read().entries[0]?.state, "retry-wait");
  });
});

test("Update journal completion drain writes bounded segments without rewriting raw updates", async () => {
  await withJournalTempDir(async ({ path }) => {
    const entryCount = 2_048;
    const store = createStore(path);
    store.appendBatch(
      Array.from({ length: entryCount }, (_, index) => ({
        update_id: index + 1,
        message: { text: `retained-raw-update-${index + 1}` },
      })),
    );
    const snapshotBefore = await readFile(path, "utf8");
    const snapshotBytes = Buffer.byteLength(snapshotBefore);
    for (let offset = 0; offset < entryCount; offset += 64) {
      store.removeCompleted(
        Array.from({ length: 64 }, (_, index) => offset + index + 1),
      );
    }
    assert.equal(await readFile(path, "utf8"), snapshotBefore);
    assert.deepEqual(store.read().entries, []);
    const segmentNames = await readdir(`${path}.segments`);
    assert.equal(segmentNames.length, entryCount / 64);
    const segmentBytes = (
      await Promise.all(
        segmentNames.map((name) => stat(join(`${path}.segments`, name))),
      )
    ).reduce((total, entry) => total + entry.size, 0);
    assert.ok(segmentBytes < snapshotBytes);
  });
});

test("Update journal rejects conflicting and unordered batches atomically", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 10, message: { text: "first" } }]);

    assert.throws(
      () =>
        store.appendBatch([
          { update_id: 10, message: { text: "changed" } },
          { update_id: 11, message: { text: "new" } },
        ]),
      (error) => isJournalError(error, "conflict"),
    );
    assert.deepEqual(
      store.read().entries.map((entry) => entry.updateId),
      [10],
    );

    assert.throws(
      () =>
        store.appendBatch([
          { update_id: 12 },
          { update_id: 11 },
        ]),
      (error) => isJournalError(error, "invalid"),
    );
    assert.deepEqual(
      store.read().entries.map((entry) => entry.updateId),
      [10],
    );
  });
});

test("Update journal capacity rejects a whole batch without partial publication", async () => {
  await withJournalTempDir(async ({ path }) => {
    const entryBounded = createStore(path, { maxEntries: 2 });
    entryBounded.appendBatch([{ update_id: 1 }]);
    assert.throws(
      () =>
        entryBounded.appendBatch([{ update_id: 2 }, { update_id: 3 }]),
      (error) => isJournalError(error, "capacity"),
    );
    assert.deepEqual(
      entryBounded.read().entries.map((entry) => entry.updateId),
      [1],
    );
  });

  await withJournalTempDir(async ({ path }) => {
    const byteBounded = createStore(path, { maxBytes: 600 });
    assert.throws(
      () =>
        byteBounded.appendBatch([
          { update_id: 1, message: { text: "x".repeat(2_000) } },
        ]),
      (error) => isJournalError(error, "capacity"),
    );
    assert.equal(byteBounded.read().exists, false);
    await writeFile(path, "x".repeat(601), "utf8");
    assert.throws(
      () => byteBounded.read(),
      (error) => isJournalError(error, "capacity"),
    );
  });
});

test("Update journal validates queued receipt schema", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    const queuedEntry = {
      updateId: 5,
      update: { update_id: 5, message: { text: "queued" } },
      admittedAtMs: 1,
      state: "queued",
      queueKind: "prompt",
      queueReceiptId: "receipt-5",
    };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [queuedEntry],
      }),
      "utf8",
    );
    assert.throws(
      () => store.read(),
      (error) => isJournalError(error, "invalid"),
    );

    const queueOwner = {
      ...queueOwnerIdentity,
      acquisitionId: "acquisition-5",
      acquiredAtMs: 2,
    };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [{ ...queuedEntry, queueOwner }],
      }),
      "utf8",
    );
    assert.deepEqual(store.read().entries[0]?.queueOwner, queueOwner);

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [
          {
            ...queuedEntry,
            queueOwner: { ...queueOwner, sessionGeneration: 0 },
          },
        ],
      }),
      "utf8",
    );
    assert.throws(
      () => store.read(),
      (error) => isJournalError(error, "invalid"),
    );

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [{ ...queuedEntry, queueReceiptId: undefined }],
      }),
      "utf8",
    );
    assert.throws(
      () => store.read(),
      (error) => isJournalError(error, "invalid"),
    );

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [
          { ...queuedEntry, queueOwner },
          {
            ...queuedEntry,
            updateId: 6,
            update: { update_id: 6 },
            queueOwner: {
              ...queueOwner,
              acquisitionId: "other-acquisition",
            },
          },
        ],
      }),
      "utf8",
    );
    assert.throws(
      () => store.read(),
      (error) => isJournalError(error, "invalid"),
    );
  });
});

test("Update journal persists retry and terminal execution failure transitions", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }]);
    const firstFailure = store.markExecutionFailure({
      updateId: 1,
      expectedAttemptCount: 0,
      failedAtMs: 100,
      failureClass: "handler-timeout",
      summary: "Handler timed out.",
      disposition: "retry-wait",
      nextRetryAtMs: 200,
    });
    assert.deepEqual(firstFailure.entry, {
      updateId: 1,
      update: { update_id: 1 },
      admittedAtMs: firstFailure.entry.admittedAtMs,
      state: "retry-wait",
      failure: {
        attemptCount: 1,
        failedAtMs: 100,
        failureClass: "handler-timeout",
        summary: "Handler timed out.",
      },
      nextRetryAtMs: 200,
    });
    const beforeStaleAttempt = await readFile(path, "utf8");
    assert.throws(
      () =>
        store.markExecutionFailure({
          updateId: 1,
          expectedAttemptCount: 0,
          failedAtMs: 150,
          failureClass: "stale-attempt",
          summary: "Stale writer.",
          disposition: "failed",
          terminalReason: "terminal:stale-attempt",
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.equal(await readFile(path, "utf8"), beforeStaleAttempt);

    const terminal = store.markExecutionFailure({
      updateId: 1,
      expectedAttemptCount: 1,
      failedAtMs: 200,
      failureClass: "handler-timeout",
      summary: "Handler timed out again.",
      disposition: "failed",
      terminalReason: "retry-exhausted:handler-timeout",
    });
    assert.match(
      terminal.entry.terminalFailureId ?? "",
      /^failure-[a-f0-9]{32}$/u,
    );
    assert.deepEqual(terminal.entry, {
      updateId: 1,
      update: { update_id: 1 },
      admittedAtMs: terminal.entry.admittedAtMs,
      state: "failed",
      failure: {
        attemptCount: 2,
        failedAtMs: 200,
        failureClass: "handler-timeout",
        summary: "Handler timed out again.",
      },
      terminalAtMs: 200,
      terminalReason: "retry-exhausted:handler-timeout",
      terminalFailureId: terminal.entry.terminalFailureId,
    });
    assert.throws(
      () =>
        store.markQueued({
          queueKind: "prompt",
          receiptId: "failed-receipt",
          sourceUpdateIds: [1],
          owner: queueOwnerIdentity,
        }),
      (error) => isJournalError(error, "conflict"),
    );

    store.markExecutionFailure({
      updateId: 2,
      expectedAttemptCount: 0,
      failedAtMs: 300,
      failureClass: "temporary",
      summary: "Temporary failure.",
      disposition: "retry-wait",
      nextRetryAtMs: 400,
    });
    const queuedControl = store.markQueued({
      queueKind: "control",
      receiptId: "control-2",
      sourceUpdateIds: [2],
      owner: queueOwnerIdentity,
    });
    assert.deepEqual(store.read().entries[1], {
      updateId: 2,
      update: { update_id: 2 },
      admittedAtMs: store.read().entries[1]!.admittedAtMs,
      state: "queued",
      queueKind: "control",
      queueReceiptId: "control-2",
      queueOwner: queuedControl.queueOwner,
    });
  });
});

test("Update journal commits exact retry and discard dispositions before terminal authority leaves", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 10 }, { update_id: 11 }]);
    const retryFailure = store.markExecutionFailure({
      updateId: 10,
      expectedAttemptCount: 0,
      failedAtMs: 100,
      failureClass: "retry-target",
      summary: "Retry this update.",
      disposition: "failed",
      terminalReason: "terminal:retry-target",
    }).entry;
    const discardFailure = store.markExecutionFailure({
      updateId: 11,
      expectedAttemptCount: 0,
      failedAtMs: 200,
      failureClass: "discard-target",
      summary: "Discard this update.",
      disposition: "failed",
      terminalReason: "terminal:discard-target",
    }).entry;
    assert.throws(
      () => store.removeCompleted([10]),
      (error) => isJournalError(error, "conflict"),
    );

    const retry = store.applyOperatorDisposition({
      action: "retry",
      updateId: 10,
      failureId: retryFailure.terminalFailureId!,
    });
    assert.equal(retry.duplicate, false);
    assert.deepEqual(store.read().entries[0], {
      updateId: 10,
      update: { update_id: 10 },
      admittedAtMs: retryFailure.admittedAtMs,
      state: "retry-wait",
      failure: retryFailure.failure,
      nextRetryAtMs: 1_000,
    });
    assert.deepEqual(retry.disposition, {
      failureId: retryFailure.terminalFailureId,
      updateId: 10,
      action: "retry",
      committedAtMs: 1_000,
      attemptCount: 1,
      failureClass: "retry-target",
      terminalAtMs: 100,
      terminalReason: "terminal:retry-target",
    });
    const afterRetry = await readFile(path, "utf8");
    assert.equal(
      store.applyOperatorDisposition({
        action: "retry",
        updateId: 10,
        failureId: retryFailure.terminalFailureId!,
      }).duplicate,
      true,
    );
    assert.equal(await readFile(path, "utf8"), afterRetry);
    assert.throws(
      () =>
        store.applyOperatorDisposition({
          action: "discard",
          updateId: 10,
          failureId: retryFailure.terminalFailureId!,
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () =>
        store.applyOperatorDisposition({
          action: "retry",
          updateId: 11,
          failureId: "failure-stale",
        }),
      (error) => isJournalError(error, "conflict"),
    );

    const discard = store.applyOperatorDisposition({
      action: "discard",
      updateId: 11,
      failureId: discardFailure.terminalFailureId!,
    });
    assert.equal(discard.duplicate, false);
    assert.deepEqual(
      store.read().entries.map((entry) => entry.updateId),
      [10],
    );
    assert.deepEqual(
      store.read().operatorDispositions?.map((entry) => ({
        updateId: entry.updateId,
        action: entry.action,
        failureId: entry.failureId,
      })),
      [
        {
          updateId: 10,
          action: "retry",
          failureId: retryFailure.terminalFailureId,
        },
        {
          updateId: 11,
          action: "discard",
          failureId: discardFailure.terminalFailureId,
        },
      ],
    );
    assert.equal(
      store.applyOperatorDisposition({
        action: "discard",
        updateId: 11,
        failureId: discardFailure.terminalFailureId!,
      }).duplicate,
      true,
    );
    assert.deepEqual(store.appendBatch([{ update_id: 11 }]), {
      nonExcludedUpdateIds: [],
      addedUpdateIds: [],
      duplicateUpdateIds: [11],
      entryCount: 1,
      serializedBytes: store.read().serializedBytes,
    });
  });
});

test("Update journal disposition publication failure preserves terminal authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    const failed = store.markExecutionFailure({
      updateId: 1,
      expectedAttemptCount: 0,
      failedAtMs: 100,
      failureClass: "capacity-target",
      summary: "Keep this terminal authority.",
      disposition: "failed",
      terminalReason: "terminal:capacity-target",
    }).entry;
    const before = await readFile(path, "utf8");
    const constrained = createStore(path, {
      maxBytes: Buffer.byteLength(before) + 1,
    });
    assert.throws(
      () =>
        constrained.applyOperatorDisposition({
          action: "retry",
          updateId: 1,
          failureId: failed.terminalFailureId!,
        }),
      (error) => isJournalError(error, "capacity"),
    );
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(store.read().entries[0]?.state, "failed");
    assert.equal(store.read().operatorDispositions, undefined);
  });
});

test("Update journal derives a stable identity for pre-disposition terminal evidence", async () => {
  await withJournalTempDir(async ({ path }) => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [
          {
            updateId: 5,
            update: { update_id: 5 },
            admittedAtMs: 1,
            state: "failed",
            failure: {
              attemptCount: 2,
              failedAtMs: 10,
              failureClass: "legacy-terminal",
              summary: "Legacy terminal evidence.",
            },
            terminalAtMs: 10,
            terminalReason: "terminal:legacy-terminal",
          },
        ],
      }),
      "utf8",
    );
    const store = createStore(path);
    const firstFailureId = store.read().entries[0]?.terminalFailureId;
    assert.match(firstFailureId ?? "", /^failure-[a-f0-9]{32}$/u);
    assert.equal(
      store.read().entries[0]?.terminalFailureId,
      firstFailureId,
    );
    store.applyOperatorDisposition({
      action: "retry",
      updateId: 5,
      failureId: firstFailureId!,
    });
    assert.equal(store.read().entries[0]?.state, "retry-wait");
    assert.equal(
      store.read().operatorDispositions?.[0]?.failureId,
      firstFailureId,
    );
  });
});

test("Update journal rejects malformed persistent failure metadata", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    const base = {
      updateId: 5,
      update: { update_id: 5 },
      admittedAtMs: 1,
      state: "retry-wait",
      failure: {
        attemptCount: 1,
        failedAtMs: 10,
        failureClass: "temporary",
        summary: "Temporary failure.",
      },
      nextRetryAtMs: 20,
    };
    for (const entry of [
      { ...base, nextRetryAtMs: undefined },
      {
        ...base,
        failure: { ...base.failure, attemptCount: 0 },
      },
      {
        ...base,
        failure: { ...base.failure, summary: "x".repeat(513) },
      },
      {
        ...base,
        state: "failed",
        nextRetryAtMs: undefined,
        terminalAtMs: 10,
      },
    ]) {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          profile: "work",
          botIdentity: identity,
          entries: [entry],
        }),
        "utf8",
      );
      assert.throws(
        () => store.read(),
        (error) => isJournalError(error, "invalid"),
      );
    }
  });
});

test("Update journal persists queue ownership and fences exact receipt completion", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }, { update_id: 2 }]);
    const queued = store.markQueued({
      queueKind: "prompt",
      receiptId: "prompt-1",
      sourceUpdateIds: [1, 2],
      owner: queueOwnerIdentity,
    });
    assert.deepEqual(queued.queuedUpdateIds, [1, 2]);
    assert.deepEqual(queued.duplicateUpdateIds, []);
    assert.deepEqual(
      {
        ...queued.queueOwner,
        acquisitionId: undefined,
      },
      {
        ...queueOwnerIdentity,
        acquisitionId: undefined,
        acquiredAtMs: 1_000,
      },
    );
    assert.match(queued.queueOwner?.acquisitionId ?? "", /^[a-f0-9-]{36}$/u);
    assert.deepEqual(
      store.read().entries.map((entry) => ({
        updateId: entry.updateId,
        state: entry.state,
        queueKind: entry.queueKind,
        queueReceiptId: entry.queueReceiptId,
        queueOwner: entry.queueOwner,
      })),
      [
        {
          updateId: 1,
          state: "queued",
          queueKind: "prompt",
          queueReceiptId: "prompt-1",
          queueOwner: queued.queueOwner,
        },
        {
          updateId: 2,
          state: "queued",
          queueKind: "prompt",
          queueReceiptId: "prompt-1",
          queueOwner: queued.queueOwner,
        },
      ],
    );

    const beforeReplay = await readFile(path, "utf8");
    const replayed = store.markQueued({
      queueKind: "prompt",
      receiptId: "prompt-1",
      sourceUpdateIds: [2, 1],
      owner: queueOwnerIdentity,
    });
    assert.deepEqual(replayed.queuedUpdateIds, []);
    assert.deepEqual(replayed.duplicateUpdateIds, [2, 1]);
    assert.deepEqual(replayed.queueOwner, queued.queueOwner);
    assert.equal(await readFile(path, "utf8"), beforeReplay);
    assert.throws(
      () =>
        store.markQueued({
          queueKind: "prompt",
          receiptId: "prompt-1",
          sourceUpdateIds: [1, 2],
          owner: {
            ...queueOwnerIdentity,
            instanceId: "foreign-instance",
          },
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.equal(await readFile(path, "utf8"), beforeReplay);
    assert.throws(
      () =>
        store.markQueued({
          queueKind: "prompt",
          receiptId: "prompt-1",
          sourceUpdateIds: [1, 2],
          owner: {
            ...queueOwnerIdentity,
            processBirthId: `${process.pid}:reused-pid`,
          },
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.equal(await readFile(path, "utf8"), beforeReplay);

    assert.throws(
      () =>
        store.markQueued({
          queueKind: "prompt",
          receiptId: "prompt-1",
          sourceUpdateIds: [1],
          owner: queueOwnerIdentity,
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () => store.removeCompleted([1, 2]),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () =>
        store.completeQueued([
          {
            queueKind: "prompt",
            receiptId: "prompt-1",
            sourceUpdateIds: [1, 2],
            queueOwner: {
              ...queued.queueOwner!,
              acquisitionId: "stale-acquisition",
            },
          },
        ]),
      (error) => isJournalError(error, "conflict"),
    );
    assert.equal(await readFile(path, "utf8"), beforeReplay);

    const completed = store.completeQueued([
      {
        queueKind: "prompt",
        receiptId: "prompt-1",
        sourceUpdateIds: [2, 1],
        queueOwner: queued.queueOwner!,
      },
    ]);
    assert.deepEqual(completed.removedUpdateIds, [1, 2]);
    assert.deepEqual(store.read().entries, []);
  });
});

test("Update journal live handoff retains donor authority until exact recipient acceptance", async () => {
  await withJournalTempDir(async ({ path }) => {
    const donorStore = createStore(path, { nowMs: 2_000 });
    donorStore.appendBatch([{ update_id: 1 }, { update_id: 2 }]);
    const receipt = {
      queueKind: "prompt" as const,
      receiptId: "live-handoff-receipt",
      sourceUpdateIds: [1, 2],
    };
    const donorOwner = donorStore.markQueued({
      ...receipt,
      owner: queueOwnerIdentity,
    }).queueOwner!;
    const recipientIdentity = {
      instanceId: "recipient-instance",
      processId: process.pid + 1,
      processBirthId: `${process.pid + 1}:recipient`,
      sessionGeneration: 4,
    };
    const handoffToken = createTelegramUpdateQueueHandoffToken();
    const handoff = {
      ...receipt,
      expectedOwner: donorOwner,
      recipientOwner: recipientIdentity,
      handoffToken,
    };

    const offered = donorStore.offerQueuedHandoff(handoff);
    assert.equal(offered.duplicate, false);
    assert.match(offered.handoff.handoffId, /^handoff-[a-f0-9]{32}$/u);
    assert.deepEqual(offered.handoff.recipientOwner, recipientIdentity);
    assert.deepEqual(
      donorStore.read().entries.map((entry) => ({
        updateId: entry.updateId,
        queueOwner: entry.queueOwner,
        queueHandoff: entry.queueHandoff,
      })),
      [1, 2].map((updateId) => ({
        updateId,
        queueOwner: donorOwner,
        queueHandoff: offered.handoff,
      })),
    );
    assert.equal(donorStore.offerQueuedHandoff(handoff).duplicate, true);
    assert.throws(
      () =>
        donorStore.discardQueued({
          ...receipt,
          expectedOwner: donorOwner,
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () =>
        donorStore.recoverDeadQueueOwner({
          ...receipt,
          deadOwner: donorOwner,
          recoveryOwner: recipientIdentity,
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () =>
        donorStore.completeQueued([
          { ...receipt, queueOwner: donorOwner },
        ]),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () =>
        donorStore.acceptQueuedHandoff({
          ...handoff,
          handoffToken: createTelegramUpdateQueueHandoffToken(),
        }),
      (error) => isJournalError(error, "conflict"),
    );

    const recipientStore = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: identity,
      getNowMs: () => 3_000,
      queueRuntimeIdentity: {
        instanceId: recipientIdentity.instanceId,
        processId: recipientIdentity.processId,
        processBirthId: recipientIdentity.processBirthId,
      },
    });
    const accepted = recipientStore.acceptQueuedHandoff(handoff);
    assert.equal(accepted.duplicate, false);
    assert.notEqual(accepted.queueOwner.acquisitionId, donorOwner.acquisitionId);
    assert.deepEqual(
      {
        ...accepted.queueOwner,
        acquisitionId: undefined,
      },
      {
        ...recipientIdentity,
        acquisitionId: undefined,
        acquiredAtMs: 3_000,
        handoffId: offered.handoff.handoffId,
      },
    );
    assert.equal(recipientStore.acceptQueuedHandoff(handoff).duplicate, true);
    assert.throws(
      () =>
        recipientStore.acceptQueuedHandoff({
          ...handoff,
          handoffToken: createTelegramUpdateQueueHandoffToken(),
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () =>
        donorStore.completeQueued([
          { ...receipt, queueOwner: donorOwner },
        ]),
      (error) => isJournalError(error, "conflict"),
    );
    const completed = recipientStore.completeQueued([
      { ...receipt, queueOwner: accepted.queueOwner },
    ]);
    assert.deepEqual(completed.removedUpdateIds, [1, 2]);
    assert.deepEqual(recipientStore.read().entries, []);
  });
});

test("Update journal donor can cancel only its exact unaccepted handoff", async () => {
  await withJournalTempDir(async ({ path }) => {
    const donorStore = createStore(path, { nowMs: 2_000 });
    donorStore.appendBatch([{ update_id: 1 }]);
    const receipt = {
      queueKind: "control" as const,
      receiptId: "cancel-handoff-receipt",
      sourceUpdateIds: [1],
    };
    const donorOwner = donorStore.markQueued({
      ...receipt,
      owner: queueOwnerIdentity,
    }).queueOwner!;
    const recipientOwner = {
      instanceId: "recipient-instance",
      processId: process.pid + 1,
      processBirthId: `${process.pid + 1}:recipient`,
      sessionGeneration: 1,
    };
    const handoff = {
      ...receipt,
      expectedOwner: donorOwner,
      recipientOwner,
      handoffToken: createTelegramUpdateQueueHandoffToken(),
    };
    donorStore.offerQueuedHandoff(handoff);
    assert.throws(
      () =>
        donorStore.cancelQueuedHandoff({
          ...handoff,
          handoffToken: createTelegramUpdateQueueHandoffToken(),
        }),
      (error) => isJournalError(error, "conflict"),
    );
    const cancelled = donorStore.cancelQueuedHandoff(handoff);
    assert.deepEqual(cancelled.cancelledUpdateIds, [1]);
    assert.throws(
      () => donorStore.cancelQueuedHandoff(handoff),
      (error) => isJournalError(error, "conflict"),
    );
    assert.equal(donorStore.read().entries[0]?.queueHandoff, undefined);
    assert.deepEqual(
      donorStore.completeQueued([{ ...receipt, queueOwner: donorOwner }])
        .removedUpdateIds,
      [1],
    );
  });
});

test("Update journal handoff metadata capacity failure preserves queue owner", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path, { nowMs: 2_000 });
    store.appendBatch([{ update_id: 1 }]);
    const receipt = {
      queueKind: "prompt" as const,
      receiptId: "handoff-capacity",
      sourceUpdateIds: [1],
    };
    const owner = store.markQueued({
      ...receipt,
      owner: queueOwnerIdentity,
    }).queueOwner!;
    const before = await readFile(path, "utf8");
    const constrained = createStore(path, {
      maxBytes: Buffer.byteLength(before) + 1,
      nowMs: 2_000,
    });
    assert.throws(
      () =>
        constrained.offerQueuedHandoff({
          ...receipt,
          expectedOwner: owner,
          recipientOwner: {
            instanceId: "recipient-instance",
            processId: process.pid + 1,
            processBirthId: `${process.pid + 1}:recipient`,
            sessionGeneration: 2,
          },
          handoffToken: createTelegramUpdateQueueHandoffToken(),
        }),
      (error) => isJournalError(error, "capacity"),
    );
    assert.equal(await readFile(path, "utf8"), before);
    const entry = store.read().entries[0];
    assert.equal(entry?.state, "queued");
    assert.deepEqual(entry?.queueOwner, owner);
    assert.equal(entry?.queueHandoff, undefined);
  });
});

test("Update journal explicit queue discard fences stale or foreign owners", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path, { nowMs: 2_000 });
    store.appendBatch([{ update_id: 1 }, { update_id: 2 }]);
    const promptOwner = store.markQueued({
      queueKind: "prompt",
      receiptId: "prompt-receipt",
      sourceUpdateIds: [1],
      owner: queueOwnerIdentity,
    }).queueOwner!;
    assert.throws(
      () =>
        store.discardQueued({
          queueKind: "prompt",
          receiptId: "prompt-receipt",
          sourceUpdateIds: [1],
          expectedOwner: {
            ...promptOwner,
            acquisitionId: "stale-acquisition",
          },
        }),
      (error) => isJournalError(error, "conflict"),
    );
    assert.throws(
      () =>
        store.discardQueued({
          queueKind: "prompt",
          receiptId: "prompt-receipt",
          sourceUpdateIds: [1],
          expectedOwner: {
            ...promptOwner,
            instanceId: "foreign-runtime",
          },
        }),
      (error) => isJournalError(error, "conflict"),
    );

    const discardOwner = store.markQueued({
      queueKind: "control",
      receiptId: "discard-receipt",
      sourceUpdateIds: [2],
      owner: queueOwnerIdentity,
    }).queueOwner!;
    const discarded = store.discardQueued({
      queueKind: "control",
      receiptId: "discard-receipt",
      sourceUpdateIds: [2],
      expectedOwner: discardOwner,
    });
    assert.deepEqual(discarded.previousOwner, discardOwner);
    assert.deepEqual(discarded.removedUpdateIds, [2]);
    assert.deepEqual(
      store.read().entries.map((entry) => entry.updateId),
      [1],
    );
  });
});

test("Update journal dead-owner cleanup requires exact negative liveness proof", async () => {
  await withJournalTempDir(async ({ path }) => {
    let ownerLiveness: "alive" | "dead" | "unverifiable" = "alive";
    const store = createStore(path, {
      nowMs: 3_000,
      getQueueProcessLiveness(owner) {
        assert.equal(owner.processId, 444);
        assert.equal(owner.processBirthId, "444:start:dead-owner");
        return ownerLiveness;
      },
    });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [
          {
            updateId: 9,
            update: { update_id: 9 },
            admittedAtMs: 1,
            state: "queued",
            queueKind: "prompt",
            queueReceiptId: "dead-owner-receipt",
            queueOwner: {
              instanceId: "dead-owner-instance",
              processId: 444,
              processBirthId: "444:start:dead-owner",
              sessionGeneration: 1,
              acquisitionId: "dead-owner-acquisition",
              acquiredAtMs: 2,
            },
          },
        ],
      }),
      "utf8",
    );
    const deadOwner = store.read().entries[0]!.queueOwner!;
    const recoveryOwner = {
      ...queueOwnerIdentity,
      sessionGeneration: 5,
    };
    const retained = store.recoverDeadQueueOwner({
      queueKind: "prompt",
      receiptId: "dead-owner-receipt",
      sourceUpdateIds: [9],
      deadOwner,
      recoveryOwner,
    });
    assert.equal(retained.status, "owner-alive");
    assert.deepEqual(store.read().entries[0]?.queueOwner, deadOwner);

    ownerLiveness = "unverifiable";
    const unverifiable = store.recoverDeadQueueOwner({
      queueKind: "prompt",
      receiptId: "dead-owner-receipt",
      sourceUpdateIds: [9],
      deadOwner,
      recoveryOwner,
    });
    assert.equal(unverifiable.status, "owner-unverifiable");
    assert.deepEqual(store.read().entries[0]?.queueOwner, deadOwner);

    ownerLiveness = "dead";
    const recovered = store.recoverDeadQueueOwner({
      queueKind: "prompt",
      receiptId: "dead-owner-receipt",
      sourceUpdateIds: [9],
      deadOwner,
      recoveryOwner,
    });
    assert.equal(recovered.status, "recovered");
    assert.deepEqual(recovered.recoveredUpdateIds, [9]);
    assert.deepEqual(store.read().entries, []);
    assert.throws(
      () =>
        store.recoverDeadQueueOwner({
          queueKind: "prompt",
          receiptId: "dead-owner-receipt",
          sourceUpdateIds: [9],
          deadOwner,
          recoveryOwner,
        }),
      (error) => isJournalError(error, "conflict"),
    );
  });

  await withJournalTempDir(async ({ path }) => {
    const currentBirthOwner = {
      instanceId: "current-birth-instance",
      processId: process.pid,
      processBirthId: getTelegramProcessBirthIdentity(
        process.pid,
        "current-test-process",
      ),
      sessionGeneration: 1,
      acquisitionId: "unknown-birth-acquisition",
      acquiredAtMs: 1,
    };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [
          {
            updateId: 1,
            update: { update_id: 1 },
            admittedAtMs: 1,
            state: "queued",
            queueKind: "prompt",
            queueReceiptId: "current-live-process",
            queueOwner: currentBirthOwner,
          },
        ],
      }),
      "utf8",
    );
    const defaultProofStore = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: identity,
      getNowMs: () => 4_000,
      queueRuntimeIdentity: {
        instanceId: queueOwnerIdentity.instanceId,
        processId: queueOwnerIdentity.processId,
        processBirthId: queueOwnerIdentity.processBirthId,
      },
    });
    const retained = defaultProofStore.recoverDeadQueueOwner({
      queueKind: "prompt",
      receiptId: "current-live-process",
      sourceUpdateIds: [1],
      deadOwner: currentBirthOwner,
      recoveryOwner: {
        ...queueOwnerIdentity,
        sessionGeneration: 2,
      },
    });
    assert.equal(
      retained.status,
      process.platform === "win32" ? "owner-unverifiable" : "owner-alive",
    );
    assert.deepEqual(
      defaultProofStore.read().entries[0]?.queueOwner,
      currentBirthOwner,
    );
  });
});

test("Update journal failure metadata capacity error preserves prior authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path, { maxBytes: 500 });
    store.appendBatch([{ update_id: 1 }]);
    assert.throws(
      () =>
        store.markExecutionFailure({
          updateId: 1,
          expectedAttemptCount: 0,
          failedAtMs: 100,
          failureClass: "large-diagnostic",
          summary: "x".repeat(400),
          disposition: "failed",
          terminalReason: "terminal:large-diagnostic",
        }),
      (error) => isJournalError(error, "capacity"),
    );
    assert.equal(store.read().entries[0]?.state, "pending");
  });
});

test("Update journal retry metadata capacity error preserves prior authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    const before = await readFile(path, "utf8");
    const constrained = createStore(path, {
      maxBytes: Buffer.byteLength(before) + 1,
    });
    assert.throws(
      () =>
        constrained.markExecutionFailure({
          updateId: 1,
          expectedAttemptCount: 0,
          failedAtMs: 100,
          failureClass: "retry-capacity",
          summary: "Retry metadata must publish atomically.",
          disposition: "retry-wait",
          nextRetryAtMs: 200,
        }),
      (error) => isJournalError(error, "capacity"),
    );
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(store.read().entries[0]?.state, "pending");
  });
});

test("Update journal queue receipt capacity failure preserves pending authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path, { maxBytes: 2_000 });
    store.appendBatch([{ update_id: 1 }]);
    assert.throws(
      () =>
        store.markQueued({
          queueKind: "prompt",
          receiptId: "r".repeat(2_000),
          sourceUpdateIds: [1],
          owner: queueOwnerIdentity,
        }),
      (error) => isJournalError(error, "capacity"),
    );
    const entry = store.read().entries[0];
    assert.equal(entry?.state, "pending");
    assert.equal(entry?.queueReceiptId, undefined);
  });
});

test("Update journal queue-owner metadata capacity failure preserves pending authority", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    store.appendBatch([{ update_id: 1 }]);
    const before = await readFile(path, "utf8");
    const constrained = createStore(path, {
      maxBytes: Buffer.byteLength(before) + 1,
    });
    assert.throws(
      () =>
        constrained.markQueued({
          queueKind: "prompt",
          receiptId: "owner-capacity",
          sourceUpdateIds: [1],
          owner: queueOwnerIdentity,
        }),
      (error) => isJournalError(error, "capacity"),
    );
    assert.equal(await readFile(path, "utf8"), before);
    const entry = store.read().entries[0];
    assert.equal(entry?.state, "pending");
    assert.equal(entry?.queueOwner, undefined);
  });
});

test("Update journal fails closed on malformed schema and identity mismatch", async () => {
  await withJournalTempDir(async ({ path }) => {
    const store = createStore(path);
    const malformedSource = "{broken";
    await writeFile(path, malformedSource, "utf8");
    assert.throws(
      () => store.read(),
      (error) => isJournalError(error, "invalid"),
    );
    assert.equal(await readFile(path, "utf8"), malformedSource);

    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        profile: "work",
        botIdentity: identity,
        entries: [],
      }),
      "utf8",
    );
    assert.throws(
      () => store.read(),
      (error) => isJournalError(error, "unsupported-version"),
    );

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "other",
        botIdentity: identity,
        entries: [],
      }),
      "utf8",
    );
    const rebound = store.read();
    assert.equal(rebound.profile, "work");
    assert.deepEqual(rebound.botIdentity, identity);

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "work",
        botIdentity: identity,
        entries: [
          {
            updateId: 5,
            update: { update_id: 6 },
            admittedAtMs: 1,
            state: "pending",
          },
        ],
      }),
      "utf8",
    );
    assert.throws(
      () => store.read(),
      (error) => isJournalError(error, "invalid"),
    );
  });
});

test("Update journal permits token rotation only when bot identity remains provable", async () => {
  await withJournalTempDir(async ({ path }) => {
    const original = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "token-a",
        botId: 42,
      }),
    });
    original.appendBatch([{ update_id: 1 }]);

    const rotated = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "token-b",
        botId: 42,
      }),
    });
    assert.equal(rotated.read().entries.length, 1);
    rotated.appendBatch([{ update_id: 1 }]);
    assert.equal(
      rotated.read().botIdentity.tokenSha256,
      createTelegramUpdateJournalBotIdentity({
        botToken: "token-b",
        botId: 42,
      }).tokenSha256,
    );

    const conflictingBot = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "token-b",
        botId: 99,
      }),
    });
    assert.throws(
      () => conflictingBot.read(),
      (error) => isJournalError(error, "identity-mismatch"),
    );
  });

  await withJournalTempDir(async ({ path }) => {
    const unknownBot = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "token-a",
      }),
    });
    unknownBot.appendBatch([{ update_id: 1 }]);
    const unprovableRotation = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "token-b",
      }),
    });
    assert.throws(
      () => unprovableRotation.read(),
      (error) => isJournalError(error, "identity-mismatch"),
    );
  });
});

test("Update journal atomically rebinds a fully drained journal", async () => {
  await withJournalTempDir(async ({ path }) => {
    const original = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "token-a",
        botId: 42,
      }),
    });
    original.appendBatch([{ update_id: 1 }], 1);
    original.removeCompleted([1]);
    assert.equal(original.read().entries.length, 0);
    assert.equal(original.read().acceptedThroughUpdateId, 1);

    const reboundIdentity = createTelegramUpdateJournalBotIdentity({
      botToken: "token-b",
      botId: 99,
    });
    const rebound = createTelegramUpdateJournalStore({
      path,
      profileName: "other",
      botIdentity: reboundIdentity,
    });
    const snapshot = rebound.read();
    assert.equal(snapshot.profile, "other");
    assert.deepEqual(snapshot.botIdentity, reboundIdentity);
    assert.deepEqual(snapshot.entries, []);
    assert.equal(snapshot.acceptedThroughUpdateId, undefined);
    rebound.appendBatch([{ update_id: 2 }]);
    assert.deepEqual(
      rebound.read().entries.map((entry) => entry.updateId),
      [2],
    );
    assert.throws(
      () => original.read(),
      (error: unknown) =>
        error instanceof TelegramUpdateJournalError &&
        error.code === "identity-mismatch",
    );
  });
});

test("Update journal serializes concurrent rebind and old-identity append", async () => {
  await withJournalTempDir(async ({ path }) => {
    const original = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "123:journal-worker",
        botId: 77,
      }),
    });
    original.appendBatch([{ update_id: 1 }]);
    original.removeCompleted([1]);

    const results = await Promise.allSettled([
      runJournalWorker(path, 1, 1, "append"),
      runJournalWorker(path, 2, 1, "rebind"),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );

    const source = JSON.parse(await readFile(path, "utf8")) as {
      profile: string;
      botIdentity: { botId?: number };
    };
    const winner = createTelegramUpdateJournalStore({
      path,
      profileName: source.profile,
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken:
          source.profile === "rebound"
            ? "123:journal-rebound"
            : "123:journal-worker",
        botId: source.botIdentity.botId,
      }),
    });
    const snapshot = winner.read();
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.updateId, source.profile === "rebound" ? 20_000 : 10_000);
  });
});

test("Update journal transaction serializes concurrent process appenders", async () => {
  await withJournalTempDir(async ({ path }) => {
    const workers = 4;
    const updatesPerWorker = 12;
    await Promise.all(
      Array.from({ length: workers }, (_value, worker) =>
        runJournalWorker(path, worker + 1, updatesPerWorker),
      ),
    );

    const store = createTelegramUpdateJournalStore({
      path,
      profileName: "work",
      botIdentity: createTelegramUpdateJournalBotIdentity({
        botToken: "123:journal-worker",
        botId: 77,
      }),
    });
    const ids = store.read().entries.map((entry) => entry.updateId);
    assert.equal(ids.length, workers * updatesPerWorker);
    assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
    assert.equal(new Set(ids).size, ids.length);
  });
});
