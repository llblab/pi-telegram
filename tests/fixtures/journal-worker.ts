/**
 * Cross-process update journal append worker
 * Zones: telegram inbound tests, filesystem concurrency
 * Invoked only by journal.test.ts to contend on one authority file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTelegramConfigStore } from "../../lib/config.ts";
import {
  createTelegramInputJournalStore,
  TelegramUpdateJournalError,
  createTelegramUpdateJournalBotIdentity,
  createTelegramUpdateJournalStore,
  type TelegramInputJournalHandoffAcceptInput,
  type TelegramInputJournalRecoveryInput,
  type TelegramUpdateJournalQueueOwnerIdentity,
} from "../../lib/journal.ts";

const [path, workerText, countText, mode = "append"] = process.argv.slice(2);
const worker = Number.parseInt(workerText ?? "", 10);
const count = Number.parseInt(countText ?? "", 10);
if (!path || !Number.isSafeInteger(worker) || !Number.isSafeInteger(count)) {
  throw new Error("journal worker requires path, worker, and count");
}

if (mode === "input-handoff-accept" || mode === "input-handoff-recover") {
  const dir = dirname(path);
  const request = JSON.parse(readFileSync(join(dir, "handoff-worker-request.json"), "utf8")) as {
    acceptance: TelegramInputJournalHandoffAcceptInput;
    recovery: TelegramInputJournalRecoveryInput;
    recipientBindingKey: string;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
  };
  const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
  await config.load(); config.activateProfile("work");
  const accepting = mode === "input-handoff-accept";
  const runtime = accepting ? request.recipientOwner : request.recoveryOwner;
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "123:synthetic-input-custody" });
  const store = createTelegramInputJournalStore({ path, profileName: "work", botIdentity,
    queueRuntimeIdentity: runtime,
    sourceAccess: { directory: dir, limits: { maxFiles: 100, maxBytes: 1_000_000, maxEntries: 100, maxWork: 1000 } },
    withSourceSerialization: config.withSourceSerialization,
    withPairingAdmission: publish => config.withPairingAdmission("work", botIdentity.tokenSha256, publish),
    getInputContext: () => ({ owner: accepting ? request.recipientOwner : request.recoveryOwner,
      recipientBindingKey: request.recipientBindingKey }),
    getQueueProcessLiveness: () => "dead",
  });
  let result: unknown;
  try {
    result = accepting
      ? { kind: "accepted", ...store.acceptInputHandoff(request.acceptance) }
      : { kind: "recovered", ...store.recoverReadyInput(request.recovery) };
  } catch (error) {
    if (!(error instanceof TelegramUpdateJournalError) || error.code !== "conflict") throw error;
    result = { kind: "refused", code: error.code };
  }
  writeFileSync(join(dir, `handoff-worker-${worker}.json`), JSON.stringify(result));
} else if (mode === "input-custody") {
  const dir = dirname(path);
  const config = createTelegramConfigStore({ agentDir: dir, configPath: join(dir, "telegram.json") });
  await config.load(); config.activateProfile("work");
  const runtime = { instanceId: `worker-${worker}`, processId: process.pid, processBirthId: `${process.pid}:fixture` };
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "123:synthetic-input-custody" });
  const store = createTelegramInputJournalStore({ path, profileName: "work", botIdentity,
    queueRuntimeIdentity: runtime,
    sourceAccess: { directory: dir, limits: { maxFiles: 100, maxBytes: 1_000_000, maxEntries: 100, maxWork: 1000 } },
    withSourceSerialization: config.withSourceSerialization,
    withPairingAdmission: publish => config.withPairingAdmission("work", botIdentity.tokenSha256, publish),
    getInputContext: () => ({ owner: { ...runtime, sessionGeneration: 1 }, recipientBindingKey: "workspace:owner" }),
  });
  let result: unknown;
  try {
    const acquisition = store.acquireInput({ updateId: count, recipientBindingKey: "workspace:owner" });
    result = { ...acquisition, started: store.startInput(acquisition.receipt).started };
  } catch (error) {
    if (!(error instanceof TelegramUpdateJournalError) || error.code !== "conflict") throw error;
    result = { acquired: false, refused: error.code };
  }
  writeFileSync(`${path}.claim-${worker}.json`, JSON.stringify(result));
} else {
  const rebind = mode === "rebind";
  const store = createTelegramUpdateJournalStore({
    path,
    profileName: rebind ? "rebound" : "work",
    botIdentity: createTelegramUpdateJournalBotIdentity({
      botToken: rebind ? "123:journal-rebound" : "123:journal-worker",
      botId: rebind ? 88 : 77,
    }),
  });
  if (rebind) store.read();
  for (let index = 0; index < count; index += 1) {
    const updateId = worker * 10_000 + index;
    store.appendBatch([
      { update_id: updateId, message: { text: `worker-${worker}-${index}` } },
    ]);
  }
}
