/**
 * Bounded subprocess-fixture transport regressions
 * Zones: test infrastructure, process isolation
 * Owns large-source transport, module semantics, complete output and early child refusal evidence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runNodeEval } from "./fixtures/node-eval.ts";

for (const length of [16, 256 * 1024])
test(`Node eval fixture transports source without command-line growth (${length})`, async () => {
  const result = await runNodeEval(`/*${"x".repeat(length)}*/
    import assert from "node:assert/strict";
    import { isWireRecord } from "./lib/wire.ts";
    assert.equal(process.argv[1], undefined);
    assert.equal(typeof globalThis.gc, "function");
    assert.equal(process.env.PI_TELEGRAM_FIXTURE_VALUE, "isolated");
    assert.equal(isWireRecord({}), true);
    console.log("module-source-ok");
  `, { nodeArgs: ["--expose-gc"], env: { PI_TELEGRAM_FIXTURE_VALUE: "isolated" } });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
  assert.equal(result.stdout.trim(), "module-source-ok");
});

test("Node eval fixture waits for complete Unicode output from both streams", async () => {
  const result = await runNodeEval('process.stdout.write("🙂".repeat(32768)); process.stderr.write("done".repeat(32768));');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.equal(result.stdout, "🙂".repeat(32768)); assert.equal(result.stderr, "done".repeat(32768));
});

test("Node eval fixture retains early Node option refusal with large pending input", async () => {
  const result = await runNodeEval("/*" + "x".repeat(256 * 1024) + "*/", { nodeArgs: ["--pi-telegram-invalid-fixture-option"] });
  assert.notEqual(result.code, 0); assert.equal(result.signal, null);
  assert.match(result.stderr, /bad option|unknown option/iu);
});
