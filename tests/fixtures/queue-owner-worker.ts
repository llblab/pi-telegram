/**
 * Cross-process queued-receipt ownership and transport-lock probe
 * Zones: telegram inbound tests, filesystem authority, process fencing
 * Invoked only by integration.test.ts as a replacement transport process.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import {
  createTelegramBusFollowerRegistry,
  createTelegramBusLocalServer,
  createTelegramBusProtocolIdentity,
  getTelegramProcessBirthIdentity,
  sendTelegramBusLocalEnvelope,
  TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
} from "../../lib/bus.ts";
import { createTelegramBusLeaderEnvelopeHandler } from "../../lib/bus-leader.ts";
import {
  createTelegramUpdateJournalBindingKey,
  createTelegramUpdateJournalBotIdentity,
  createTelegramUpdateJournalStore,
  TelegramUpdateJournalError,
} from "../../lib/journal.ts";
import { createTelegramLockRuntime, isProcessAlive } from "../../lib/locks.ts";
import {
  createTelegramQueueHandoffStagingRuntime,
  createTelegramQueueStore,
  type TelegramQueueHandoffStageResult,
} from "../../lib/queue.ts";
import {
  createTelegramQueueHandoffRecipientRuntime,
  createTelegramUpdateAdmissionLifecycleRuntime,
  createTelegramUpdateWorkerRuntime,
} from "../../lib/updates.ts";

interface TransportHandoffInput {
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

interface RegistrationRecoveryRaceInput {
  journalPath: string;
  socketPath: string;
  startPath: string;
  instanceId: string;
  profileKey: string;
  registrationGeneration: string;
  target: { chatId: number; threadId: number; slot: string };
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function runRegistrationRecoveryRace(
  input: RegistrationRecoveryRaceInput,
): Promise<void> {
  const processBirthId = getTelegramProcessBirthIdentity(
    process.pid,
    input.instanceId,
  );
  const ownerIdentity = {
    instanceId: input.instanceId,
    processId: process.pid,
    processBirthId,
    sessionGeneration: 1,
  };
  const staleEntry = JSON.parse(
    await readFile(input.journalPath, "utf8"),
  ) as { entries: Array<{ queueOwner?: { acquisitionId: string; acquiredAtMs: number } }> };
  const staleOwner = staleEntry.entries[0]?.queueOwner;
  if (!staleOwner) throw new Error("race journal has no queue owner");
  staleEntry.entries[0]!.queueOwner = {
    ...ownerIdentity,
    acquisitionId: staleOwner.acquisitionId,
    acquiredAtMs: staleOwner.acquiredAtMs,
  };
  await writeFile(input.journalPath, JSON.stringify(staleEntry), "utf8");
  const journal = createTelegramUpdateJournalStore({
    path: input.journalPath,
    botIdentity: createTelegramUpdateJournalBotIdentity({
      botToken: "123:queue-owner-worker",
    }),
    queueRuntimeIdentity: ownerIdentity,
    getQueueProcessLiveness(owner) {
      return owner.processId === process.pid &&
        owner.processBirthId === processBirthId &&
        isProcessAlive(process.pid)
        ? "alive"
        : "dead";
    },
  });
  const registry = createTelegramBusFollowerRegistry();
  const protocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "fixture",
    capabilities: [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF],
  });
  const server = createTelegramBusLocalServer({
    socketPath: input.socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      protocolIdentity: protocol,
      provisionFollowerTarget: (registration) => registration.target,
    }),
  });
  await server.start();
  process.stdout.write(
    `${JSON.stringify({ phase: "ready", pid: process.pid, processBirthId })}\n`,
  );
  await waitForFile(input.startPath);
  const [registration, recovery] = await Promise.all([
    Promise.resolve().then(() => {
      return sendTelegramBusLocalEnvelope({
        socketPath: input.socketPath,
        envelope: {
          kind: "follower.register",
          requestId: input.registrationGeneration,
          registration: {
            instanceId: input.instanceId,
            profileKey: input.profileKey,
            pid: process.pid,
            processBirthId,
            sessionGeneration: 1,
            registrationGeneration: input.registrationGeneration,
            protocol,
            target: input.target,
            slot: input.target.slot,
            connectedAtMs: Date.now(),
          },
        },
      });
    }),
    Promise.resolve().then(() => {
      const entry = journal.read().entries[0];
      if (!entry?.queueOwner) throw new Error("race journal has no queue owner");
      try {
        return journal.recoverDeadQueueOwner({
          queueKind: entry.queueKind!,
          receiptId: entry.queueReceiptId!,
          sourceUpdateIds: [entry.updateId],
          deadOwner: entry.queueOwner,
          recoveryOwner: ownerIdentity,
        }).status;
      } catch (error) {
        return error instanceof TelegramUpdateJournalError
          ? error.code
          : "unexpected";
      }
    }),
  ]);
  const registered = registry.get(input.instanceId);
  process.stdout.write(
    `${JSON.stringify({
      phase: "result",
      registrationOk: registration?.kind === "bus.ack" && registration.ok,
      recoveryStatus: recovery,
      registeredPid: registered?.pid,
      registeredProcessBirthId: registered?.processBirthId,
      ownerAlive: isProcessAlive(process.pid),
      journalState: journal.read().entries[0]?.state,
      journalOwnerPid: journal.read().entries[0]?.queueOwner?.processId,
    })}\n`,
  );
  process.exitCode = 0;
}

async function runTransportHandoff(input: TransportHandoffInput): Promise<void> {
  const processBirthId = getTelegramProcessBirthIdentity(
    process.pid,
    input.recipientInstanceId,
  );
  const recipientOwner = {
    instanceId: input.recipientInstanceId,
    processId: process.pid,
    processBirthId,
    sessionGeneration: 1,
  };
  const botIdentity = createTelegramUpdateJournalBotIdentity({
    botToken: "123:queue-owner-worker",
  });
  const recipientJournalBindingKey = createTelegramUpdateJournalBindingKey({
    path: input.recipientJournalPath,
    botIdentity,
  });
  const recipientJournal = createTelegramUpdateJournalStore({
    path: input.recipientJournalPath,
    botIdentity,
    queueRuntimeIdentity: recipientOwner,
  });
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: input.recipientJournalPath,
      recoveryKey: recipientJournalBindingKey,
      journal: recipientJournal,
    }),
    getQueueOwnerIdentity: () => recipientOwner,
    createWorker(journal) {
      return createTelegramUpdateWorkerRuntime({
        journal,
        hasAuthority: () => true,
        getJournalBindingKey: () => recipientJournalBindingKey,
        getQueueOwnerIdentity: () => recipientOwner,
        executeUpdate: () => ({ kind: "complete" }),
      });
    },
  });
  const liveStore = createTelegramQueueStore<string>();
  const controlExecutions: string[] = [];
  const staging = createTelegramQueueHandoffStagingRuntime({
    liveStore,
    createControlExecution: (payload) => async () => {
      controlExecutions.push(payload.controlType);
    },
  });
  let handoffCount = 0;
  const acceptQueueHandoff = createTelegramQueueHandoffRecipientRuntime({
    staging,
    getRecipientOwner: () => recipientOwner,
    getLifecycleForBinding(binding) {
      return lifecycle.ownsJournalBinding(binding) ? lifecycle : undefined;
    },
    isTransportStampActive: () => true,
    dispatchNext: () => undefined,
  });
  const handleQueueHandoff: typeof acceptQueueHandoff = async (envelope, ctx) => {
    const result = await acceptQueueHandoff(envelope, ctx);
    handoffCount += 1;
    return result;
  };
  const lock = createTelegramLockRuntime<{ cwd: string }>({
    locksPath: input.ownersPath,
    instanceId: input.recipientInstanceId,
  });
  const observed = lock.getState();
  if (observed.kind !== "active-elsewhere") {
    throw new Error(`expected a live donor transport owner, received ${observed.kind}`);
  }
  const acquired = lock.acquire(
    { cwd: input.donorCwd },
    { force: true, expectedOwner: observed.lock },
  );
  if (!acquired.ok) throw new Error("replacement transport acquisition failed");

  const registry = createTelegramBusFollowerRegistry();
  const protocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "fixture",
    capabilities: [TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF],
  });
  registry.register({
    instanceId: input.recipientInstanceId,
    profileKey: input.recipientProfileKey,
    target: input.target,
    busSocketPath: input.socketPath,
    registrationGeneration: input.recipientRegistrationGeneration,
    protocol,
    pid: process.pid,
    processBirthId,
    sessionGeneration: 1,
    connectedAtMs: Date.now(),
  });
  const handleLeaderEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    authSecret: input.authSecret,
    protocolIdentity: protocol,
  });
  const handleEnvelope = async (
    envelope: Parameters<typeof handleLeaderEnvelope>[0],
  ) => {
    if (envelope.kind !== "leader.offerQueueHandoff") {
      return handleLeaderEnvelope(envelope);
    }
    if (
      envelope.auth !== input.authSecret ||
      envelope.recipientInstanceId !== input.recipientInstanceId ||
      envelope.recipientRegistrationGeneration !==
        input.recipientRegistrationGeneration
    ) {
      return {
        kind: "bus.ack" as const,
        requestId: envelope.requestId,
        ok: false,
        message: "Unauthorized or stale Telegram queue handoff envelope.",
      };
    }
    try {
      const result: TelegramQueueHandoffStageResult =
        await handleQueueHandoff(envelope, "recipient-context");
      return {
        kind: "bus.ack" as const,
        requestId: envelope.requestId,
        ok: true,
        result,
      };
    } catch (error) {
      return {
        kind: "bus.ack" as const,
        requestId: envelope.requestId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
  let droppedHandoffAck = false;
  const server = createTelegramBusLocalServer({
    socketPath: input.socketPath,
    handleEnvelope,
    shouldDropResponse(request, response) {
      const shouldDrop = Boolean(
        input.dropHandoffAck &&
        request.kind === "leader.offerQueueHandoff" &&
        response.kind === "bus.ack" &&
        response.ok,
      );
      if (shouldDrop) droppedHandoffAck = true;
      return shouldDrop;
    },
  });
  await server.start();

  const replacementJournal = createTelegramUpdateJournalStore({
    path: input.journalPath,
    botIdentity,
    queueRuntimeIdentity: recipientOwner,
  });
  let executionCount = 0;
  const replacementWorker = createTelegramUpdateWorkerRuntime({
    journal: replacementJournal,
    hasAuthority: () => lock.owns({ cwd: input.donorCwd }),
    getQueueOwnerIdentity: () => recipientOwner,
    executeUpdate() {
      executionCount += 1;
      return { kind: "complete" };
    },
  });
  replacementWorker.start("replacement-context");
  await replacementWorker.waitForDrain();
  const replacementForeignQueuedCount =
    replacementWorker.getState().foreignQueuedCount;
  await replacementWorker.stop();
  await lifecycle.onSessionStart("recipient-context");
  process.stdout.write(
    `${JSON.stringify({
      phase: "ready",
      pid: process.pid,
      processBirthId,
      transportOwned: lock.owns({ cwd: input.donorCwd }),
      executionCount,
      foreignQueuedCount: replacementForeignQueuedCount,
      recipientJournalBindingKey,
    })}\n`,
  );

  await new Promise<void>((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      const command = chunk.trim();
      if (command === "stop") resolve();
      else if (command === "execute-control") {
        const item = liveStore.getQueuedItems()[0];
        if (!item || item.kind !== "control") {
          reject(new Error("recipient has no live control to execute"));
          return;
        }
        void item.execute("recipient-context").then(() => resolve(), reject);
      } else {
        reject(new Error(`unknown queue owner worker command: ${command}`));
      }
    });
    process.stdin.once("error", reject);
  });
  process.stdout.write(
    `${JSON.stringify({
      phase: "stopped",
      executionCount,
      foreignQueuedCount: replacementForeignQueuedCount,
      donorEntryCount: recipientJournal.read().entries.length,
      recipientEntryCount: lifecycle.getJournalEntryCount(),
      recipientQueueCount: liveStore.getQueuedItems().length,
      handoffCount,
      controlExecutions,
      droppedHandoffAck,
    })}\n`,
  );
  await lifecycle.onSessionShutdown();
  lock.release();
  process.exitCode = 0;
}

const [path, mode = "observe", encodedInput] = process.argv.slice(2);
if (mode === "transport-handoff") {
  if (!encodedInput) throw new Error("transport handoff input is required");
  await runTransportHandoff(JSON.parse(encodedInput) as TransportHandoffInput);
} else if (mode === "registration-recovery-race") {
  if (!encodedInput) throw new Error("registration recovery race input is required");
  await runRegistrationRecoveryRace(
    JSON.parse(encodedInput) as RegistrationRecoveryRaceInput,
  );
} else {
  if (!path) throw new Error("queue owner worker requires a journal path");
  const processBirthId = getTelegramProcessBirthIdentity(
    process.pid,
    "fixture-replacement",
  );
  const queueOwnerIdentity = {
    instanceId: `replacement-${process.pid}`,
    processId: process.pid,
    processBirthId,
    sessionGeneration: 1,
  };
  const journal = createTelegramUpdateJournalStore({
    path,
    botIdentity: createTelegramUpdateJournalBotIdentity({
      botToken: "123:queue-owner-worker",
    }),
    queueRuntimeIdentity: {
      instanceId: queueOwnerIdentity.instanceId,
      processId: process.pid,
      processBirthId,
    },
  });
  let executionCount = 0;
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "process-a-receipt",
    sourceUpdateIds: [1],
  };
  const worker = createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => true,
    getQueueOwnerIdentity: () => queueOwnerIdentity,
    executeUpdate() {
      executionCount += 1;
      return { kind: "complete" };
    },
  });

  worker.start("replacement-context");
  await worker.waitForDrain();
  worker.completeQueueReceipts({
    receipts: [receipt],
    ctx: "replacement-context",
    reason: "prompt-handoff",
  });
  await worker.waitForDrain();

  const foreignEntry = journal.read().entries[0];
  let directCompletionError: string | undefined;
  try {
    journal.completeQueued([
      {
        ...receipt,
        queueOwner: foreignEntry!.queueOwner!,
      },
    ]);
  } catch (error) {
    directCompletionError =
      error instanceof TelegramUpdateJournalError ? error.code : "unexpected";
  }
  let recoveryStatus: string | undefined;
  if (mode === "recover") {
    const recovered = journal.recoverDeadQueueOwner({
      ...receipt,
      deadOwner: foreignEntry!.queueOwner!,
      recoveryOwner: queueOwnerIdentity,
    });
    recoveryStatus = recovered.status;
    if (recovered.status === "recovered") {
      worker.signal();
      await worker.waitForDrain();
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      executionCount,
      foreignQueuedCount: worker.getState().foreignQueuedCount,
      queuedClaimCount: worker.getState().queuedClaimCount,
      entryCount: journal.read().entries.length,
      directCompletionError,
      recoveryStatus,
    })}\n`,
  );
  await worker.stop();
}
