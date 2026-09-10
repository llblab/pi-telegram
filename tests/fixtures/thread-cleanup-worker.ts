import { closeSync, openSync, writeFileSync } from "node:fs";
import {
  createTelegramInactiveThreadCleanupSettingsPort,
  createTelegramThreadCleanupPermitRuntime,
  createTelegramThreadCleanupWorkStore,
  type TelegramThreadCleanupCandidate,
} from "../../lib/thread-cleanup-manager.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../../lib/workspace-admission.ts";

const [workPath, ledgerPath, markerPath, attemptDir, operationId, candidateJson] = process.argv.slice(2);
if (!workPath || !ledgerPath || !markerPath || !attemptDir || !operationId || !candidateJson)
  throw new Error("thread cleanup worker arguments are required");
const candidate = JSON.parse(candidateJson) as TelegramThreadCleanupCandidate;
const owner = { processId: process.pid, processBirthId: `${process.pid}:worker` };
const store = createTelegramThreadCleanupWorkStore({ path: workPath,
  profileName: candidate.profileName, tokenSha256: "a".repeat(64) });
const ledger = createTelegramWorkspaceAdmissionLedger({ path: ledgerPath,
  profileKey: candidate.profileName, owner, getProcessLiveness: () => "unknown" });
const permitRuntime = createTelegramThreadCleanupPermitRuntime({ ledger,
  getLeaderEpoch: () => 1, getProfileName: () => "work", getOwner: () => owner, canAdoptFence: () => false,
  async revalidateUnderFence() { return true; } });
const clean = createTelegramInactiveThreadCleanupSettingsPort({ store, permitRuntime,
  async resolveFullBinding() { return candidate; },
  async deleteWithPermit() {
    writeFileSync(`${attemptDir}/${process.pid}.attempt`, "attempt", { mode: 0o600 });
    const fd = openSync(markerPath, "wx", 0o600);
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    await new Promise(resolve => setTimeout(resolve, 40));
  },
  async commitBinding() { return true; },
});
process.stdout.write(`${JSON.stringify(await clean(operationId))}\n`);
