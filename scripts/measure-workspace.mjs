// Measures isolated Thread-store work; never reads configured profiles or calls Telegram.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramTopicTargetStore } from "../lib/threads.ts";

const repetitions = 10;
const original = { readFile: fs.readFile, writeFile: fs.writeFile, mkdir: fs.mkdir, rename: fs.rename,
  parse: JSON.parse, stringify: JSON.stringify };
let counts;
const rows = [];
const root = await fs.mkdtemp(join(tmpdir(), "pi-telegram-measure-workspace-"));

async function measure(size, operation, execute, samples = repetitions) {
  counts = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0, mkdirs: 0, renames: 0,
    parses: 0, stringifies: 0 };
  try {
    for (let index = 0; index < samples; index++) await execute(index);
    const result = { size, operation, repetitions: samples, ...counts };
    rows.push(result);
    return result;
  } finally {
    counts = undefined;
  }
}

try {
  fs.readFile = async (...args) => {
    if (counts) counts.reads++;
    const result = await original.readFile(...args);
    if (counts) counts.readBytes += Buffer.byteLength(result);
    return result;
  };
  fs.writeFile = async (...args) => {
    if (counts) { counts.writes++; counts.writeBytes += Buffer.byteLength(args[1]); }
    return original.writeFile(...args);
  };
  fs.mkdir = async (...args) => {
    if (counts) counts.mkdirs++;
    return original.mkdir(...args);
  };
  fs.rename = async (...args) => {
    if (counts) counts.renames++;
    return original.rename(...args);
  };
  JSON.parse = (...args) => { if (counts) counts.parses++; return original.parse(...args); };
  JSON.stringify = (...args) => { if (counts) counts.stringifies++; return original.stringify(...args); };
  syncBuiltinESMExports();

  for (const size of [1, 13, 26]) {
    const path = join(root, `${size}.json`);
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    for (let index = 0; index < size; index++) {
      const instanceId = `fixture-${index}`;
      const identity = store.claimWorkspaceIdentity(`/fixture/${index}`, instanceId);
      assert.ok(identity);
      const target = { chatId: 7, threadId: index + 1 };
      assert.ok(store.upsertWorkspaceBinding({ ...identity, target, updatedAtMs: 1000 }, instanceId));
      store.upsert({ profileKey: `manual:${instanceId}`, instanceId, slot: identity.slot,
        target, status: "active", createdAtMs: 1000, updatedAtMs: 1000 });
    }
    await store.persist();
    assert.equal(new Set(store.listWorkspaceBindings().map((entry) => entry.slot)).size, size);
    await measure(size, "cold-load", async () => {
      const reader = createTelegramTopicTargetStore({ path });
      await reader.load();
      assert.equal(reader.list().length, size);
      assert.equal(reader.listWorkspaceBindings().length, size);
    });
    const lookup = await measure(size, "lookup-last", () => {
      assert.equal(store.getByProfileKey(`manual:fixture-${size - 1}`)?.target.threadId, size);
    });
    assert.equal(lookup.reads + lookup.writes, 0);
    const beforeReloadSave = JSON.parse(await fs.readFile(path, "utf8"));
    const reloaded = await measure(size, "first-persist-after-reload", () => store.persist(), 1);
    assert.equal(reloaded.writes + reloaded.renames + reloaded.mkdirs, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), beforeReloadSave,
      "The first reloaded save must preserve the seeded semantic state");
    const unchanged = await measure(size, "unchanged-persist", () => store.persist());
    assert.equal(unchanged.writes + unchanged.renames + unchanged.mkdirs, 0);
    assert.ok(unchanged.reads >= repetitions, "No-op saves still consult disk authority");
    const changed = await measure(size, "diagnostic-persist", async (index) => {
      store.setStatusSnapshot({ diagnostics: { measurementStep: index } });
      await store.persist();
    });
    assert.equal(changed.writes, repetitions);
    assert.equal(changed.renames, repetitions);
  }
} finally {
  Object.assign(fs, { readFile: original.readFile, writeFile: original.writeFile,
    mkdir: original.mkdir, rename: original.rename });
  JSON.parse = original.parse;
  JSON.stringify = original.stringify;
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ scope: "Isolated Thread store, not IPC/admission/Telegram or throughput",
  counters: "Aggregate API calls and bytes for each row's repetitions; object-spread clones are not instrumented",
  rows }, null, 2));
