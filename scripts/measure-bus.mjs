// Counts isolated registry work without sockets, configured profiles, or Telegram calls.
import assert from "node:assert/strict";
import { createTelegramBusFollowerRegistry, createTelegramBusProtocolIdentity } from "../lib/bus.ts";

const repetitions = 10;
const methods = ["get", "set", "delete", "entries", "values"];
const originals = Object.fromEntries(methods.map((name) => [name, Map.prototype[name]]));
const rows = [];
let counts;

function measure(size, operation, execute) {
  const sample = { gets: 0, sets: 0, deletes: 0, entryVisits: 0, valueVisits: 0 };
  let result;
  counts = sample;
  try {
    for (let index = 0; index < repetitions; index++) result = execute(index);
  } finally {
    counts = undefined;
  }
  rows.push({ size, operation, repetitions, ...sample });
  return { result, counts: sample };
}

try {
  for (const [method, counter] of [["get", "gets"], ["set", "sets"], ["delete", "deletes"]]) {
    Map.prototype[method] = function (...args) {
      if (counts) counts[counter]++;
      return originals[method].apply(this, args);
    };
  }
  for (const [method, counter] of [["entries", "entryVisits"], ["values", "valueVisits"]]) {
    Map.prototype[method] = function* (...args) {
      for (const entry of originals[method].apply(this, args)) {
        if (counts) counts[counter]++;
        yield entry;
      }
    };
  }
  for (const size of [1, 13, 26]) {
    const registry = createTelegramBusFollowerRegistry();
    const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "measurement" });
    const registrations = Array.from({ length: size }, (_, index) => ({
      instanceId: `fixture-${index}`, profileKey: `manual:fixture-${index}`,
      registrationGeneration: `generation-${index}`, connectedAtMs: 1000,
      target: { chatId: 7, threadId: index + 1 }, protocol,
    }));
    for (const registration of registrations) registry.register(registration);
    const last = registrations.at(-1);
    const registered = measure(size, "reregister-last", () => registry.register(last));
    assert.equal(registered.counts.entryVisits, size * repetitions);
    const heartbeat = measure(size, "heartbeat-last", (index) => registry.heartbeat(last.instanceId, 2000 + index));
    assert.equal(heartbeat.result.lastHeartbeatMs, 2000 + repetitions - 1);
    assert.equal(heartbeat.counts.entryVisits + heartbeat.counts.valueVisits, 0);
    assert.equal(heartbeat.counts.gets, repetitions);
    assert.equal(heartbeat.counts.sets, repetitions);
    const first = measure(size, "target-first", () => registry.getByTarget(registrations[0].target));
    assert.equal(first.result.instanceId, registrations[0].instanceId);
    assert.equal(first.counts.valueVisits, repetitions);
    const tail = measure(size, "target-last", () => registry.getByTarget(last.target));
    assert.equal(tail.result.instanceId, last.instanceId);
    assert.equal(tail.counts.valueVisits, size * repetitions);
    const missing = measure(size, "target-missing-chat", () => registry.getByTarget({ chatId: 8, threadId: size }));
    assert.equal(missing.result, undefined);
    assert.equal(missing.counts.valueVisits, size * repetitions);
    const roster = measure(size, "list", () => registry.list());
    assert.equal(roster.result.length, size);
    assert.equal(roster.counts.valueVisits, size * repetitions);
    for (const view of [registered.result, heartbeat.result, first.result, tail.result, ...roster.result]) {
      const expected = registry.get(view.instanceId);
      view.target.chatId = 99;
      view.protocol.capabilities.push("fixture-only");
      assert.deepEqual(registry.get(view.instanceId), expected, "Returned views must not mutate registry authority");
    }
  }
} finally {
  for (const method of methods) Map.prototype[method] = originals[method];
}
console.log(JSON.stringify({
  scope: "Synchronous isolated follower registry, not IPC, authentication, provisioning, or throughput",
  counters: "Aggregate Map operations and visited entries for each row's repetitions; no allocation or timing claims",
  copyEvidence: "Mutating returned target/protocol capability views leaves registry authority unchanged",
  rows,
}, null, 2));
