/**
 * Cross-process update journal append worker
 * Zones: telegram inbound tests, filesystem concurrency
 * Invoked only by journal.test.ts to contend on one authority file.
 */

import {
  createTelegramUpdateJournalBotIdentity,
  createTelegramUpdateJournalStore,
} from "../../lib/journal.ts";

const [path, workerText, countText, mode = "append"] = process.argv.slice(2);
const worker = Number.parseInt(workerText ?? "", 10);
const count = Number.parseInt(countText ?? "", 10);
if (!path || !Number.isSafeInteger(worker) || !Number.isSafeInteger(count)) {
  throw new Error("journal worker requires path, worker, and count");
}

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
