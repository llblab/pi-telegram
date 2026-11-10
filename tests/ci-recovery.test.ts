/**
 * Recovery CI sampling preserves failures, native outcomes and exact selected coverage.
 * Zones: CI, test execution, diagnostic artifacts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runNodeEval } from "./fixtures/node-eval.ts";

test("Recovery diagnostic runner never turns later success or missing coverage into a passing cohort", { timeout: 15000 }, async () => {
  const result = await runNodeEval(`
    import assert from "node:assert/strict";
    import { mkdtempSync, readFileSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    import { runRecoveryDiagnostics } from "./scripts/run-recovery-diagnostics.mjs";
    const dir = mkdtempSync(join(tmpdir(), "pt-ci-recovery-"));
    try {
      for (const fault of ["none", "first-round", "skipped", "zero-tests", "spawn-error", "thrown"]) {
        const outputDir = join(dir, fault); let calls = 0;
        const execute = (command, args, options) => {
          calls++;
          assert.equal(command, process.execPath);
          assert.ok(args.includes("--test-concurrency=1"));
          assert.ok(args.some(arg => arg.startsWith("--test-name-pattern=^Production separate OS roots")));
          assert.equal(options.env.PI_TELEGRAM_INTEGRATION_SHARD, undefined);
          assert.equal(options.env.PI_TELEGRAM_INTEGRATION_LIST, undefined);
          assert.ok(options.env.PI_TELEGRAM_RECOVERY_DIAGNOSTICS_DIR.startsWith(outputDir));
          assert.equal(options.shell, undefined);
          if (calls === 1 && fault === "thrown") throw new Error("native launch refused 123:os-original");
          const failed = calls === 1 && fault !== "none";
          const tests = failed && fault === "zero-tests" ? 0 : 5;
          const passes = failed ? (fault === "skipped" ? 4 : 0) : 5;
          const failures = failed && fault === "first-round" ? 1 : 0;
          return { status: failures ? 1 : 0, signal: null,
            ...(failed && fault === "spawn-error" ? { error: new Error("native launch refused 123:os-original") } : {}),
            stdout: "# tests " + tests + "\\n# pass " + passes + "\\n# fail " + failures + "\\n", stderr: "123:os-original" };
        };
        const exit = runRecoveryDiagnostics({ rounds: 3, outputDir, execute,
          env: { PATH: process.env.PATH, PI_TELEGRAM_INTEGRATION_SHARD: "3/4", PI_TELEGRAM_INTEGRATION_LIST: "1" } });
        assert.equal(exit, fault === "none" ? 0 : 1);
        assert.equal(calls, 3, "A failed observation is retained, not retried or used to truncate later observations");
        const summaryPath = join(outputDir, "summary.json"), original = readFileSync(summaryPath, "utf8"), summary = JSON.parse(original);
        assert.equal(summary.complete, true); assert.equal(summary.attempts.length, 3);
        assert.deepEqual(summary.attempts.map(row => row.passed), [fault === "none", true, true]);
        assert.ok(!original.includes("123:os-original"));
        assert.equal(readFileSync(join(outputDir, "round-001", "stderr.log"), "utf8").includes("123:os-original"), false);
        assert.throws(() => runRecoveryDiagnostics({ rounds: 1, outputDir, execute }), /EEXIST/);
        assert.equal(calls, 3); assert.equal(readFileSync(summaryPath, "utf8"), original, "A second invocation cannot overwrite retained evidence");
      }
      for (const rounds of [0, 21, 1.5, NaN]) assert.throws(() => runRecoveryDiagnostics({ rounds, outputDir: join(dir, "invalid") }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `, { timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stdout + result.stderr);
});
