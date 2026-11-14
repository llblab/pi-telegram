/**
 * Regression tests for project architecture invariants
 * Guards import graph shape, shared-bucket bans, and polling SDK boundary rules
 * Zones: shared utils, telegram, pi agent
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { runNodeEval } from "./fixtures/node-eval.ts";
import { createIntegrationShardSelector } from "./fixtures/shared.ts";

const PROJECT_ROOT = process.cwd();
const releaseWorkflowSource = readFileSync(
  join(PROJECT_ROOT, ".github", "workflows", "release.yml"),
  "utf8",
);
const validateWorkflowSource = readFileSync(
  join(PROJECT_ROOT, ".github", "workflows", "validate.yml"),
  "utf8",
);
const changelogSource = readFileSync(
  join(PROJECT_ROOT, "CHANGELOG.md"),
  "utf8",
);

function getProjectTypeScriptFiles(): string[] {
  return [
    "index.ts",
    ...readdirSync(join(PROJECT_ROOT, "api"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("api", name)),
    ...readdirSync(join(PROJECT_ROOT, "lib"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("lib", name)),
    ...readdirSync(join(PROJECT_ROOT, "tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => join("tests", name)),
  ].sort();
}

test("Local operator design notes stay outside default Git and npm publication", () => {
  const gitRules = readFileSync(join(PROJECT_ROOT, ".gitignore"), "utf8").split(/\r?\n/);
  const npmRules = readFileSync(join(PROJECT_ROOT, "docs", ".npmignore"), "utf8").split(/\r?\n/);
  assert.ok(gitRules.includes("/docs/prompt-overlay-design.md"));
  assert.ok(npmRules.includes("prompt-overlay-design.md"));
  assert.ok(!gitRules.some(rule => rule.startsWith("!") && rule.includes("prompt-overlay-design")));
  assert.ok(!npmRules.some(rule => rule.startsWith("!") && rule.includes("prompt-overlay-design")));
});

test("Unreleased changelog respects the project release-entry budget", () => {
  const unreleased = changelogSource.match(
    /^## Unreleased\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu,
  )?.[1];
  assert.ok(unreleased, "CHANGELOG.md must retain an Unreleased section");
  const entries = unreleased
    .split("\n")
    .filter((line) => line.startsWith("- "));
  assert.ok(entries.length <= 8, "Unreleased must contain at most 8 entries");
  assert.deepEqual(
    entries.filter((entry) => entry.length > 512),
    [],
    "Unreleased entries must contain at most 512 characters",
  );
});

test("CI native progress stays finite, body-free and separate from native completion", async () => {
  const result = await runNodeEval(String.raw`
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { resolve } from "node:path";
    import nativeReporter, { createNativeTestProgressProjection } from "./scripts/ci-test-progress.mjs";
    const file = resolve("fixture", "tests", "integration.test.ts");
    const name = "123:private-title\n::error::must-not-escape";
    const data = (title, extra = {}) => ({ file, name: title, nesting: 0, line: 92, column: 13, ...extra });
    const dequeue = title => ({ type: "test:dequeue", data: data(title, { type: "test" }) });
    const complete = (title, passed, extra = {}) => ({ type: "test:complete", data: data(title, { details: { passed, type: "test", get error() { throw new Error("Do not inspect native error bodies"); } }, ...extra }) });
    const summary = (count, extra = {}) => ({ type: "test:summary", data: { file, success: !extra.failed, counts: { tests: count, passed: count, failed: 0, cancelled: 0, skipped: 0, todo: 0, ...extra } } });
    const project = createNativeTestProgressProjection(file), output = [];
    const observe = event => { const row = project(event); if (row) output.push(row); return row; };
    assert.equal(observe({ type: "test:stdout", get data() { throw new Error("Do not inspect stdout bodies"); } }), undefined);
    assert.equal(observe({ type: "test:dequeue", data: { file: "/foreign", get name() { throw new Error("Foreign event cannot enter projection"); } } }), undefined);
    assert.equal(observe({ type: "test:dequeue", data: data("nested", { nesting: 1, type: "test" }) }), undefined);
    assert.equal(observe({ type: "test:dequeue", data: data(file, { line: 1, column: 1, type: "test" }) }), undefined, "The native file wrapper is not a top-level body");
    for (let index = 1; index <= 1024; index++) {
      observe(dequeue(name));
      observe(complete(name, index !== 500, index === 7 ? { skip: "123:skip-reason" } : {}));
    }
    observe(summary(1024, { passed: 1022, failed: 1, skipped: 1 }));
    assert.equal(output.length, 8, "Six milestones, one first failure and one original summary are the entire output budget");
    assert.deepEqual(output.filter(row => row.phase === "dequeued").map(row => row.dequeued), [1, 64, 128, 192, 256, 320]);
    const failure = output.find(row => row.phase === "native-test-failed");
    assert.equal(failure.dequeued, 500); assert.equal(failure.nativeCompleted, 500);
    assert.equal(failure.id, createHash("sha256").update(name).digest("hex"));
    assert.equal(output.at(-1).phase, "native-summary"); assert.equal(output.at(-1).counts.skipped, 1);
    const encoded = output.map(row => JSON.stringify(row)).join("\n");
    assert.ok(Buffer.byteLength(encoded) <= 4096);
    assert.equal(encoded.includes("123:"), false, "Progress must never contain raw private labels"); assert.equal(encoded.includes("::error"), false);
    assert.equal(encoded.includes(file), false); assert.equal(encoded.includes("body"), false);
    assert.equal(observe(dequeue(name)), undefined, "A native summary cannot be renewed by later events");
    const lost = createNativeTestProgressProjection(file);
    assert.equal(lost(complete(name, true))?.phase, "unavailable");
    assert.equal(lost(dequeue(name)), undefined, "Missing original dequeue cannot be reconstructed from completion");
    const duplicate = createNativeTestProgressProjection(file);
    duplicate(dequeue(name)); duplicate(complete(name, true));
    assert.equal(duplicate(complete(name, true)).phase, "unavailable");
    const partial = createNativeTestProgressProjection(file);
    partial(dequeue(name));
    assert.equal(partial(summary(1)).phase, "unavailable", "A summary cannot settle a held or missing completion");
    const changed = createNativeTestProgressProjection(file);
    changed(dequeue(name));
    assert.equal(changed(complete("replacement", true)).phase, "unavailable");
    const oversized = createNativeTestProgressProjection(file);
    assert.equal(oversized(dequeue("x".repeat(513))).phase, "unavailable");
    const ordered = createNativeTestProgressProjection(file);
    assert.equal(ordered({ type: "test:start", data: data(name) }), undefined, "Reporting order is not dequeue authority");
    const chunks = [];
    const incomplete = async function* () { yield { type: "test:dequeue", data: { ...dequeue(name).data, file: resolve("tests/integration.test.ts") } }; };
    for await (const chunk of nativeReporter(incomplete())) chunks.push(chunk);
    assert.equal(chunks.length, 1); assert.equal(chunks[0].includes("native-summary"), false, "Stream EOF is not a native test summary");
    for (const flag of ["true", "false", "TRUE", ""]) {
      process.env.GITHUB_ACTIONS = flag;
      const events = async function* () {
        for (let index = 1; index <= 1024; index++) {
          yield { ...dequeue(name), data: { ...dequeue(name).data, file: resolve("tests/integration.test.ts") } };
          yield { ...complete(name, index !== 500), data: { ...complete(name, index !== 500).data, file: resolve("tests/integration.test.ts") } };
        }
        yield { ...summary(1024, { passed: 1023, failed: 1 }), data: { ...summary(1024, { passed: 1023, failed: 1 }).data, file: resolve("tests/integration.test.ts") } };
      };
      const framed = [];
      for await (const chunk of nativeReporter(events())) framed.push(chunk);
      assert.equal(framed.length, 8);
      assert.ok(Buffer.byteLength(framed.join("")) <= 4096, "Workflow framing must retain the entire finite byte budget");
      const prefix = flag === "true" ? "::notice title=CI native progress::" : "ci-native-progress:";
      for (const line of framed) {
        assert.ok(line.startsWith(prefix), "Only exact GitHub CI selects the constant notice command");
        assert.equal(line.split("\n").length, 2, "One record cannot inject a second command line");
        const payload = line.slice(prefix.length).trim();
        assert.equal(payload.includes("123:"), false); assert.equal(payload.includes("::error"), false);
        assert.equal(payload.includes(file), false); assert.equal(payload.includes("%"), false);
        assert.equal(JSON.parse(payload).v, 1);
      }
    }
    console.log("finite-native-progress-pass");
  `, { timeoutMs: 5000 });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /finite-native-progress-pass/u);
});

test("CI progress reporter observes public native events without changing TAP or cancellation", { timeout: 20000 }, async () => {
  const result = await runNodeEval(String.raw`
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { createHash } from "node:crypto";
    import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
    import { join, resolve } from "node:path";
    import { tmpdir } from "node:os";
    import { setTimeout as delay } from "node:timers/promises";
    import { pathToFileURL } from "node:url";
    const reporterSource = resolve("scripts/ci-test-progress.mjs");
    const name = "held-123:private-title\n::error::not-a-command";
    for (const github of [false, true]) for (const mode of ["healthy", "failure", "timeout", "SIGTERM", "SIGKILL"]) {
      const root = mkdtempSync(join(tmpdir(), "pt-progress-native # % λ-"));
      mkdirSync(join(root, "tests"));
      const reporterPath = join(root, "progress # % λ.mjs");
      writeFileSync(reporterPath, readFileSync(reporterSource));
      const reporter = pathToFileURL(reporterPath).href;
      const entered = join(root, "entered"), release = join(root, "release");
      writeFileSync(join(root, "tests", "integration.test.ts"), [
        'import assert from "node:assert/strict"; import test from "node:test";',
        'import { existsSync, writeFileSync } from "node:fs"; import { setTimeout as delay } from "node:timers/promises";',
        'test(' + JSON.stringify(name) + ', { timeout: ' + (mode === "timeout" ? 150 : 4000) + ' }, async () => {',
        'writeFileSync(' + JSON.stringify(entered) + ', "body-entered"); const end = performance.now() + 3000;',
        'while (!existsSync(' + JSON.stringify(release) + ')) { if (performance.now() >= end) throw new Error("Probe release missing"); await delay(10); }',
        ...(mode === "failure" ? ['assert.fail("123:assertion-body");'] : []),
        '});',
        'test("skip-123:hidden", { skip: "123:reason" }, () => assert.fail("Skipped body cannot run"));',
        'test("last-native-pass", () => {});',
      ].join("\n"));
      const env = { ...process.env, GITHUB_ACTIONS: github ? "true" : "false" }; delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1",
        "--test-reporter=tap", "--test-reporter-destination=stdout", "--test-reporter=" + reporter,
        "--test-reporter-destination=" + (github ? "stdout" : "stderr"), "tests/integration.test.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", closed = false;
      child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
      const completion = new Promise((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
      });
      const prefix = github ? "::notice title=CI native progress::" : "ci-native-progress:";
      const records = () => (github ? stdout : stderr).split("\n").filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
      const until = async predicate => { const end = performance.now() + 2000; while (!predicate() && !closed && performance.now() < end) await delay(10); return predicate(); };
      let native, primary;
      try {
        assert.equal(await until(() => existsSync(entered) && records().length > 0), true, mode + ": " + stderr);
        assert.deepEqual(records(), [{ v: 1, phase: "dequeued", dequeued: 1, nativeCompleted: 0, id: createHash("sha256").update(name).digest("hex") }]);
        assert.equal(closed, false); assert.equal(existsSync(release), false);
        if (mode === "timeout") {
          assert.equal(await until(() => records().some(row => row.phase === "native-test-failed")), true, stderr);
          assert.equal(existsSync(release), false, "A native timeout record cannot certify original-body drain");
        }
        if (mode === "SIGTERM" || mode === "SIGKILL") { assert.equal(child.kill(mode), true); await delay(75); }
      } catch (error) { primary = error; throw error; }
      finally {
        writeFileSync(release, "release");
        let timer;
        try {
          native = await Promise.race([completion, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Native progress reporter did not drain after original body release")), 2000);
          })]);
        } catch (error) {
          if (!closed) child.kill("SIGKILL");
          await completion;
          if (!primary) throw error;
          console.error("Secondary native progress cleanup failure:", error);
        } finally {
          clearTimeout(timer);
          writeFileSync(join(root, "stdout.log"), stdout); writeFileSync(join(root, "stderr.log"), stderr);
        }
      }
      const projected = records();
      assert.equal(JSON.stringify(projected).includes("123:"), false); assert.equal(JSON.stringify(projected).includes(root), false);
      assert.equal(stdout.includes("ci-native-progress:"), false);
      assert.equal(stdout.includes("::notice title=CI native progress::"), github);
      assert.equal(projected.some(row => row.phase === "unavailable"), false, stderr);
      if (mode === "SIGTERM" || mode === "SIGKILL") {
        const forced = mode === "SIGKILL" || process.platform === "win32";
        assert.deepEqual(native, forced ? { code: null, signal: mode } : { code: 1, signal: null });
        assert.equal(projected.some(row => row.phase === "native-summary" || row.phase === "native-test-failed"), false);
        assert.doesNotMatch(stdout, /# tests 3\b/u);
      } else {
        assert.deepEqual(native, { code: mode === "healthy" ? 0 : 1, signal: null });
        assert.match(stdout, /# tests 3\b/u); assert.match(stdout, /# skipped 1\b/u);
        assert.equal(projected.at(-1).phase, "native-summary", stderr);
        assert.equal(projected.at(-1).counts.tests, 3); assert.equal(projected.at(-1).counts.skipped, 1);
        assert.equal(projected.filter(row => row.phase === "native-test-failed").length, mode === "healthy" ? 0 : 1);
      }
      rmSync(root, { recursive: true, force: true });
    }
    console.log("native-progress-boundaries-pass");
  `, { timeoutMs: 15000 });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /native-progress-boundaries-pass/u);
});

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

test("CI integration failures retain native details before a later test drains", async () => {
  const observation = await runNodeEval(String.raw`
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const root = mkdtempSync(join(tmpdir(), "pt-ci-stream # % λ-"));
    const entered = join(root, "entered"), release = join(root, "release");
    mkdirSync(join(root, "scripts")); mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
    for (const script of ["run-ci-tests.mjs", "ci-test-progress.mjs"])
      writeFileSync(join(root, "scripts", script), readFileSync("scripts/" + script));
    writeFileSync(join(root, "tests", "fixtures", "canonical-tmpdir.ts"), "export {};\n");
    writeFileSync(join(root, "tests", "process-shutdown.test.ts"), "export {};\n");
    writeFileSync(join(root, "tests", "integration.test.ts"), [
      "import assert from 'node:assert/strict'; import test from 'node:test';",
      "import { existsSync, writeFileSync } from 'node:fs'; import { setTimeout as delay } from 'node:timers/promises';",
      "test('early-native-failure', () => assert.fail('early-native-details'));",
      "test('later-held-test', async () => {",
      "writeFileSync(" + JSON.stringify(entered) + ", 'ready'); const deadline = Date.now() + 8000;",
      "while (!existsSync(" + JSON.stringify(release) + ")) { if (Date.now() >= deadline) throw new Error('Held fixture did not drain'); await delay(10); }",
      "});",
    ].join("\n"));
    const env = { ...process.env, GITHUB_ACTIONS: "true" }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [join(root, "scripts", "run-ci-tests.mjs"), "integration", "0"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "", stderr = "", closed = false;
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    const until = async (predicate, ms) => {
      const deadline = Date.now() + ms;
      while (!predicate() && !closed && Date.now() < deadline) await delay(10);
      return predicate();
    };
    let earlyDetails = false, earlyProgress = false, result;
    try {
      assert.equal(await until(() => existsSync(entered), 5000), true, "Native test startup must reach its held checkpoint: " + stderr);
      await until(() => {
        earlyDetails = stdout.includes("not ok 1 - early-native-failure") && stdout.includes("early-native-details");
        earlyProgress = stdout.includes('"phase":"native-test-failed"');
        return earlyDetails && earlyProgress;
      }, 2000);
      assert.equal(closed, false, "The native runner must still await the later test");
    } finally {
      writeFileSync(release, "drain"); result = await completion;
      rmSync(root, { recursive: true, force: true });
    }
    assert.deepEqual(result, { code: 1, signal: null }, "Expected failure must settle naturally, not by cancellation");
    assert.equal(child.killed, false);
    assert.equal(earlyDetails, true, "Original native failure details must be available before release/EOF: " + stdout);
    assert.equal(earlyProgress, true, "Original finite notice must be available before release/EOF: " + stdout);
    assert.match(stdout, /# tests 2/); assert.match(stdout, /# fail 1/);
    const notices = stdout.split("\n").filter(line => line.startsWith("::notice title=CI native progress::"));
    assert.equal(notices.length, 3, "The existing CI runner must publish dequeue, first failure and original summary");
    assert.equal(notices.join("").includes("early-native"), false, "Notice data cannot borrow original TAP error bodies");
    assert.equal(JSON.parse(notices.at(-1).slice("::notice title=CI native progress::".length)).success, false);
  `, { timeoutMs: 15_000 });
  assert.equal(observation.signal, null);
  assert.equal(observation.code, 0, observation.stdout + observation.stderr);
});

test("CI shards cover every domain file exactly once without widening deadlines", () => {
  const runner = join(PROJECT_ROOT, "scripts", "run-ci-tests.mjs");
  const inventory = readdirSync(join(PROJECT_ROOT, "tests"))
    .filter((name) => name.endsWith(".test.ts")).map((name) => `tests/${name}`).sort();
  const list = (shard: string, phase: string): string[] => JSON.parse(execFileSync(
    process.execPath, [runner, phase, shard, "--list"], { encoding: "utf8" },
  ));
  const realProcess = "tests/process-shutdown.test.ts";
  assert.deepEqual(list("0", "process"), [realProcess]);
  assert.deepEqual(list("1", "process"), []);
  const first = list("0", "domains"), second = list("1", "domains");
  assert.ok(first.length > 0 && second.length > 0);
  assert.ok(Math.abs(first.length - second.length) <= 1);
  const all = [...list("0", "process"), ...first, ...second];
  assert.equal(new Set(all).size, all.length, "Shards cannot overlap");
  assert.deepEqual(all.sort(), inventory.filter(name => name !== "tests/integration.test.ts"), "No domain file can disappear from macOS CI");
  assert.deepEqual(list("all", "domains").sort(), inventory.filter(name => name !== "tests/integration.test.ts"));
  assert.deepEqual(list("0", "domains"), first, "Selection is deterministic");
  assert.deepEqual(Array.from(validateWorkflowSource.matchAll(/- os: macos-26-intel\s+suite: domains\s+shard: (\d+)/g),
    (match) => Number(match[1])), [0, 1]);
  for (const os of ["ubuntu-latest", "windows-latest", "macos-26-intel"]) {
    const count = os === "windows-latest" ? 4 : 8;
    const matrix = new RegExp(`- os: ${os}\\s+suite: integration\\s+integrationShard: (\\d+)\\s+integrationCount: (\\d+)\\s+shardName: ", integration (\\d+)/(\\d+)"`, "g");
    assert.deepEqual(Array.from(validateWorkflowSource.matchAll(matrix), match => match.slice(1).map(Number)),
      Array.from({ length: count }, (_, index) => [index, count, index + 1, count]),
      `${os} integration matrix must cover each exact native bucket once with its matching label`);
    for (let index = 0; index < count; index++) assert.deepEqual(list(`${index}/${count}`, "integration"), ["tests/integration.test.ts"]);
  }
  assert.match(validateWorkflowSource, /timeout-minutes: 30/);
  assert.match(validateWorkflowSource, /matrix\.os == 'macos-26-intel' && matrix\.suite == 'domains' && matrix\.shard == 0/);
  assert.match(validateWorkflowSource, /run: node scripts\/run-ci-tests\.mjs process 0/);
  assert.match(validateWorkflowSource, /run: node scripts\/run-ci-tests\.mjs domains \$\{\{ matrix\.shard \}\}/);
  assert.match(validateWorkflowSource, /run: node scripts\/run-ci-tests\.mjs integration \$\{\{ matrix\.integrationShard \}\}\/\$\{\{ matrix\.integrationCount \}\}/);
  assert.match(readFileSync(runner, "utf8"), /\? 4 : 1/);
  for (const args of [["domains", "2"], ["unknown", "0"], ["process", "0", "extra"], ["integration", "4"],
    ["integration", "8/8"], ["integration", "4/4"], ["integration", "0/6"], ["integration", "00/8"]])
    assert.throws(() => execFileSync(process.execPath, [runner, ...args], { stdio: "pipe" }));
});

test("CI runner forwards the exact shard to its native child without inherited filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-ci-spec # % λ-"));
  try {
    await mkdir(join(root, "scripts")); await mkdir(join(root, "tests", "fixtures"), { recursive: true });
    for (const script of ["run-ci-tests.mjs", "ci-test-progress.mjs"])
      await writeFile(join(root, "scripts", script), readFileSync(join(PROJECT_ROOT, "scripts", script)));
    await writeFile(join(root, "tests", "fixtures", "canonical-tmpdir.ts"), "export {};\n");
    await writeFile(join(root, "tests", "process-shutdown.test.ts"), "export {};\n");
    for (const [argument, expected] of [["0", "0/4"], ["0/4", "0/4"], ["7/8", "7/8"]] as const) {
      await writeFile(join(root, "tests", "integration.test.ts"), [
        'import assert from "node:assert/strict"; import test from "node:test";',
        'test("native-shard-body", () => {',
        `assert.equal(process.env.PI_TELEGRAM_INTEGRATION_SHARD, ${JSON.stringify(expected)});`,
        'assert.equal(process.env.PI_TELEGRAM_INTEGRATION_LIST, undefined);',
        'console.log("native-shard-accepted");',
        '});',
      ].join("\n"));
      const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: argument === "0/4" ? "true" : "false", PI_TELEGRAM_INTEGRATION_SHARD: "foreign", PI_TELEGRAM_INTEGRATION_LIST: "1" };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [join(root, "scripts", "run-ci-tests.mjs"), "integration", argument],
        { cwd: root, env, encoding: "utf8", timeout: 10000 });
      assert.ifError(result.error); assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /native-shard-accepted/u); assert.match(result.stdout, /# pass 1\b/u);
      assert.equal(result.stdout.includes("::notice title=CI native progress::"), env.GITHUB_ACTIONS === "true");
      assert.equal(result.stdout.includes("ci-native-progress:"), false);
    }
    await writeFile(join(root, "tests", "integration.test.ts"), "export {};\n");
    const empty = spawnSync(process.execPath, [join(root, "scripts", "run-ci-tests.mjs"), "integration", "0/4"],
      { cwd: root, env: { ...process.env, GITHUB_ACTIONS: "true", NODE_TEST_CONTEXT: undefined }, encoding: "utf8", timeout: 10000 });
    assert.ifError(empty.error); assert.equal(empty.signal, null); assert.equal(empty.status, 0, empty.stdout + empty.stderr);
    assert.equal(empty.stdout.includes("::notice title=CI native progress::"), false, "File-only TAP success is not a semantic test progress witness");
    await rm(join(root, "scripts", "ci-test-progress.mjs"));
    for (const [phase, argument] of [["process", "0"], ["domains", "all"]] as const) {
      const nonIntegration = spawnSync(process.execPath, [join(root, "scripts", "run-ci-tests.mjs"), phase, argument],
        { cwd: root, env: { ...process.env, GITHUB_ACTIONS: "true", NODE_TEST_CONTEXT: undefined }, encoding: "utf8", timeout: 10000 });
      assert.ifError(nonIntegration.error); assert.equal(nonIntegration.signal, null);
      assert.equal(nonIntegration.status, 0, nonIntegration.stdout + nonIntegration.stderr);
      assert.equal(nonIntegration.stdout.includes("::notice title=CI native progress::"), false, "Other CI phases must not even load the progress reporter");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Integration CI name shards are exhaustive, disjoint and use actual registrations", t => {
  const list = (specification?: string): string[] => {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_TELEGRAM_INTEGRATION_LIST: "1" };
    delete env.PI_TELEGRAM_INTEGRATION_SHARD;
    if (specification !== undefined) env.PI_TELEGRAM_INTEGRATION_SHARD = specification;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "tests/integration.test.ts"], {
      cwd: PROJECT_ROOT, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    });
    const lines = output.split(/\r?\n/u).filter(line => line.startsWith("integration-inventory:"));
    assert.equal(lines.length, 1); return JSON.parse(lines[0]!.slice("integration-inventory:".length)) as string[];
  };
  const all = list(); assert.ok(all.length > 0);
  assert.deepEqual(all.filter(name => name.startsWith("Production question root") && name.includes("/app-coheads/")),
    ["source", "compiled"].flatMap(source => [false, true].flatMap(threaded => [false, true].map(rich =>
      `Production question root uses original SDK binding at birth, not ACK (${source}/${threaded}/app-coheads/rich=${rich})`))),
    "The independent app co-head control must retain every source, target-mode and rendering configuration");
  const partitions = new Map<number, string[][]>();
  for (const count of [4, 8]) {
    const shards = Array.from({ length: count }, (_, index) => {
      const spec = `${index}/${count}`, selected = list(spec), selector = createIntegrationShardSelector(spec);
      assert.ok(selected.length > 0); assert.deepEqual(selected, all.filter(selector)); return selected;
    });
    assert.deepEqual(shards.flat().sort(), [...all].sort(), "Every registration must execute exactly once, including duplicate names");
    for (const name of new Set(all)) assert.equal(shards.filter(shard => shard.includes(name)).length, 1, name);
    partitions.set(count, shards);
    t.diagnostic(`Integration registrations: ${all.length}; ${count}-way shard sizes: ${shards.map(shard => shard.length).join(", ")}`);
  }
  for (let index = 0; index < 4; index++) {
    const original = all.filter(name => createHash("sha256").update(name).digest().readUInt32BE(0) % 4 === index);
    assert.deepEqual(partitions.get(4)![index], original, "The original four-way mapping remains unchanged for Windows and legacy selectors");
    assert.deepEqual([...partitions.get(8)![index]!, ...partitions.get(8)![index + 4]!].sort(), [...original].sort(),
      "Each Linux/macOS eight-way pair refines one original bucket without omissions or duplicates");
  }
  for (const value of ["", "4/4", "8/8", "-1/4", "01/4", "00/8", "0/0", "0/5", "0/6", "0/16", "0/4x", " 0/4"]) {
    assert.throws(() => createIntegrationShardSelector(value), /Integration shard/);
  }
  assert.ok(all.every(createIntegrationShardSelector()));
  const source = readFileSync(join(PROJECT_ROOT, "tests/integration.test.ts"), "utf8");
  assert.equal([...source.matchAll(/\bnativeTest\(/gu)].length, 1, "Every registration must pass the selector");
  assert.match(source, /if \(!selectIntegrationTest\(name\)\) return/);
});

async function createNativeBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), "pt-build-#%-λ-"));
  for (const path of ["scripts", ".git", "node_modules/typescript/bin", "skills", "lib"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "scripts/build-dist.mjs"), readFileSync(join(PROJECT_ROOT, "scripts/build-dist.mjs")));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, ".git/HEAD"), "ab".repeat(20) + "\n");
  await writeFile(join(root, "skills/probe.md"), "fixture asset\n");
  await mkdir(join(root, "skills/nested λ#"));
  await writeFile(join(root, "skills/nested λ#/percent %.md"), "nested Unicode asset\n");
  await writeFile(join(root, "lib/generative-app-worker.mjs"), "export {};\n");
  await writeFile(join(root, "node_modules/typescript/package.json"), '{"type":"commonjs"}');
  await writeFile(join(root, "node_modules/typescript/bin/tsc"), `
    const { mkdirSync, writeFileSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    const { setTimeout: delay } = require("node:timers/promises");
    (async () => {
      if (process.env.BUILD_FIXTURE_ENTERED) writeFileSync(process.env.BUILD_FIXTURE_ENTERED, "entered");
      while (process.env.BUILD_FIXTURE_RELEASE && !existsSync(process.env.BUILD_FIXTURE_RELEASE)) await delay(10);
      writeFileSync(join(process.cwd(), "compiler-argv.json"), JSON.stringify(process.execArgv));
      const out = process.argv[process.argv.indexOf("--outDir") + 1];
      mkdirSync(join(out, "lib"), { recursive: true });
      writeFileSync(join(out, "index.js"), "export default function() {}\\r\\n");
      console.log("original compiler stdout"); console.error("original compiler stderr");
      if (process.env.BUILD_FIXTURE_FAILURE === "signal") { process.kill(process.pid, "SIGTERM"); return; }
      process.exitCode = Number(process.env.BUILD_FIXTURE_FAILURE ?? 0);
    })();
  `);
  return root;
}

function readNativeBuildRecords(stdout: string): Record<string, unknown>[] {
  return stdout.split(/\r?\n/u).filter(line => line.startsWith("::notice title=CI native build::"))
    .map(line => JSON.parse(line.slice("::notice title=CI native build::".length)) as Record<string, unknown>);
}

test("CI build checkpoints retain native compiler outcomes and rollback-safe publication", { timeout: 20000 }, async () => {
  const root = await createNativeBuildFixture();
  const copyProbe = "data:text/javascript," + encodeURIComponent(`
    import { mock } from "node:test";
    import fs from "node:fs";
    mock.module("node:fs", { namedExports: { ...fs, cpSync(source, destination, options) {
      if (options?.recursive && (typeof options.filter !== "function" || options.filter(source, destination) !== true))
        throw new Error("Build directory copy must use the portable explicit-filter traversal");
      return fs.cpSync(source, destination, options);
    } } });
  `);
  const run = (github = "true", args: string[] = [], failure = "0") => spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", copyProbe, "scripts/build-dist.mjs", ...args], {
    cwd: root, encoding: "utf8", timeout: 5000,
    env: { ...process.env, GITHUB_ACTIONS: github, BUILD_FIXTURE_FAILURE: failure, PRIVATE_BUILD_FIXTURE: "never disclose this value" },
  });
  try {
    const built = run(); assert.equal(built.status, 0, built.stdout + built.stderr); assert.equal(built.signal, null);
    const records = readNativeBuildRecords(built.stdout);
    assert.deepEqual(records.map(r => r.phase), ["build-entered", "compiler-invoking", "compiler-node-entered", "compiler-node-exiting", "compiler-returned", "assets-prepared", "publication-invoking", "publication-complete"]);
    assert.equal(records[1]!.detachedHead, "ab".repeat(20));
    assert.equal(records[0]!.pid, built.pid); assert.equal(records[2]!.ppid, built.pid);
    assert.equal(records[2]!.pid, records[4]!.childPid); assert.equal(records[3]!.code, 0); assert.equal(records[4]!.code, 0);
    assert.ok(built.stdout.includes("original compiler stdout")); assert.ok(built.stderr.includes("original compiler stderr"));
    assert.ok(Buffer.byteLength(built.stdout.split(/\r?\n/u).filter(line => line.startsWith("::notice title=CI native build::")).join("\n")) <= 4096);
    const fields = new Set(["v", "build", "phase", "pid", "ppid", "uptimeMs", "check", "detachedHead", "childPid", "code", "signal", "spawnError"]);
    assert.match(String(records[0]!.build), /^[a-f0-9]{16}$/u);
    assert.ok(records.every(r => r.build === records[0]!.build));
    assert.ok(records.every(r => Object.keys(r).every(key => fields.has(key))));
    assert.ok(records.every(r => Object.values(r).every(value => typeof value !== "string" || !value.includes(root) && !value.includes("never disclose"))));
    for (const pid of new Set(records.map(r => r.pid))) {
      const clock = records.filter(r => r.pid === pid).map(r => Number(r.uptimeMs));
      assert.ok(clock.every((at, i) => Number.isSafeInteger(at) && at >= 0 && (!i || at >= clock[i - 1]!)));
    }
    const checked = run("true", ["--check"]); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.equal(readNativeBuildRecords(checked.stdout).at(-1)!.phase, "publication-complete");
    assert.notEqual(readNativeBuildRecords(checked.stdout)[0]!.build, records[0]!.build, "Another build cannot borrow the original invocation identity");
    assert.equal(readFileSync(join(root, "dist/skills/nested λ#/percent %.md"), "utf8"), "nested Unicode asset\n");
    const originalDist = readFileSync(join(root, "dist/index.js"));
    const failed = run("true", [], "7"); assert.equal(failed.status, 1); assert.equal(failed.signal, null);
    const failure = readNativeBuildRecords(failed.stdout);
    assert.equal(failure.find(r => r.phase === "compiler-node-exiting")!.code, 7);
    assert.equal(failure.find(r => r.phase === "compiler-returned")!.code, 7);
    assert.ok(!failure.some(r => r.phase === "publication-complete")); assert.match(failed.stderr, /exited with status 7/);
    assert.deepEqual(readFileSync(join(root, "dist/index.js")), originalDist);
    const nativeSignal = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--outDir", join(root, "signal-reference")], {
      cwd: root, encoding: "utf8", timeout: 5000, env: { ...process.env, BUILD_FIXTURE_FAILURE: "signal" },
    });
    assert.equal(nativeSignal.error, undefined);
    assert.ok(nativeSignal.signal !== null || nativeSignal.status !== 0, "Original signal control must not be a healthy compiler exit");
    const signalled = run("true", [], "signal"), signalRecord = readNativeBuildRecords(signalled.stdout).find(r => r.phase === "compiler-returned")!;
    assert.equal(signalled.status, 1); assert.equal(signalRecord.code, nativeSignal.status); assert.equal(signalRecord.signal, nativeSignal.signal);
    assert.ok(!readNativeBuildRecords(signalled.stdout).some(r => r.phase === "publication-complete"));
    assert.deepEqual(readFileSync(join(root, "dist/index.js")), originalDist);
    await writeFile(join(root, "dist/index.js"), "stale dist");
    const stale = run("true", ["--check"]); assert.equal(stale.status, 1); assert.match(stale.stderr, /dist\/index.js is stale/);
    assert.ok(!readNativeBuildRecords(stale.stdout).some(r => r.phase === "publication-complete"));
    assert.equal(readFileSync(join(root, "dist/index.js"), "utf8"), "stale dist");
    for (const github of ["false", "TRUE", ""]) {
      const ordinary = run(github); assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
      assert.deepEqual(readNativeBuildRecords(ordinary.stdout), []);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "compiler-argv.json"), "utf8")), [], "Non-CI compiler arguments remain unchanged");
    }
    assert.ok(!readdirSync(root).some(name => name.startsWith(".dist-build-") || name.startsWith(".dist-backup-")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CI build compiler entry cannot certify held body completion or publication", { timeout: 20000 }, async () => {
  const root = await createNativeBuildFixture(), entered = join(root, "entered"), release = join(root, "release");
  const child = spawn(process.execPath, ["scripts/build-dist.mjs"], { cwd: root,
    env: { ...process.env, GITHUB_ACTIONS: "true", BUILD_FIXTURE_ENTERED: entered, BUILD_FIXTURE_RELEASE: release }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  try {
    const deadline = performance.now() + 2000;
    while ((!existsSync(entered) || !readNativeBuildRecords(stdout).some(r => r.phase === "compiler-node-entered")) && !closed && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(entered), "Original compiler body must enter within its startup observation");
    assert.ok(readNativeBuildRecords(stdout).some(r => r.phase === "compiler-node-entered"), "Original compiler Node entry must be visible while its body is held");
    assert.equal(closed, false); assert.equal(existsSync(join(root, "dist")), false);
    assert.ok(!readNativeBuildRecords(stdout).some(r => ["compiler-node-exiting", "compiler-returned", "publication-complete"].includes(String(r.phase))));
    await writeFile(release, "release");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([completion, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Native build did not drain after original compiler release")), 2000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(result.code, 0, stdout + stderr); assert.equal(result.signal, null);
    assert.equal(readNativeBuildRecords(stdout).at(-1)!.phase, "publication-complete");
  } finally {
    await writeFile(release, "release");
    if (!closed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([completion.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1000); })])
        .finally(() => clearTimeout(timer));
    }
    if (!closed) child.kill("SIGKILL");
    await completion.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Release CI validates exact tags and publishes through npm Trusted Publisher", () => {
  assert.match(validateWorkflowSource, /^  workflow_call:$/m);
  assert.match(
    releaseWorkflowSource,
    /uses: \.\/\.github\/workflows\/validate\.yml/,
  );
  assert.match(releaseWorkflowSource, /needs: validate/);
  assert.match(
    releaseWorkflowSource,
    /group: release-\$\{\{ github\.ref_name \}\}/,
  );
  assert.match(releaseWorkflowSource, /HEAD\^\{commit\}/);
  assert.match(
    releaseWorkflowSource,
    /refs\/tags\/\$\{tagName\}\^\{commit\}/,
  );
  assert.match(releaseWorkflowSource, /packageLock\.version !== version/);
  assert.match(releaseWorkflowSource, /require npm >= 11\.5\.1/);
  assert.match(
    releaseWorkflowSource,
    /npm view "\$PACKAGE_NAME@\$VERSION" --json version gitHead/,
  );
  assert.match(
    releaseWorkflowSource,
    /npm publish --access public --provenance/,
  );
  assert.match(
    releaseWorkflowSource,
    /npm pack "\$PACKAGE_NAME@\$VERSION" --dry-run --json/,
  );
  assert.match(releaseWorkflowSource, /\.\/dist\/pi-telegram\/index\.js/);
  assert.match(releaseWorkflowSource, /\.\/dist\/skills/);
  assert.match(releaseWorkflowSource, /dist\/index\.d\.ts/);
  assert.match(releaseWorkflowSource, /dist\/skills\/telegram-bridge\/SKILL\.md/);
  assert.match(
    releaseWorkflowSource,
    /gh release view[\s\S]*gh release edit[\s\S]*gh release create/,
  );
  assert.doesNotMatch(releaseWorkflowSource, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test("Release CI keeps prerelease tags out of GitHub and npm latest", () => {
  assert.match(releaseWorkflowSource, /npm publish --access public --provenance --tag \$\{\{ contains\(github\.ref_name, '-'\) && 'next' \|\| 'latest' \}\}/);
  const commands = [...releaseWorkflowSource.matchAll(/gh release (?:edit|create) "\$TAG_NAME"[\s\S]*?(?=\n\s*(?:else|fi)\b)/gu)];
  assert.equal(commands.length, 2, "Both existing and new releases must retain the same tag classification");
  for (const [command] of commands) {
    assert.match(command, /--prerelease=\$\{\{ contains\(github\.ref_name, '-'\) \}\}/);
    assert.match(command, /--latest=\$\{\{ !contains\(github\.ref_name, '-'\) \}\}/);
  }
});

function getProjectSourceFiles(): string[] {
  return [
    "index.ts",
    ...readdirSync(join(PROJECT_ROOT, "api"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("api", name)),
    ...readdirSync(join(PROJECT_ROOT, "lib"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("lib", name)),
  ].sort();
}

function getImportSpecifiersFromSource(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    specifiers.add(match[1] ?? "");
  }
  for (const match of source.matchAll(/import\s+["']([^"']+)["']/g)) {
    specifiers.add(match[1] ?? "");
  }
  for (const match of source.matchAll(/import\s*\(\s*["']([^"']+)["']/g)) {
    specifiers.add(match[1] ?? "");
  }
  return [...specifiers];
}

function getImportSpecifiers(file: string): string[] {
  return getImportSpecifiersFromSource(
    readFileSync(join(PROJECT_ROOT, file), "utf8"),
  );
}

function resolveProjectImport(
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = normalize(join(PROJECT_ROOT, fromFile, "..", specifier));
  const relativePath = relative(PROJECT_ROOT, resolved);
  return relativePath.startsWith("..") ? undefined : relativePath;
}

function buildProjectImportGraph(files: string[]): Map<string, string[]> {
  const fileSet = new Set(files.map((file) => normalize(file)));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const deps: string[] = [];
    for (const specifier of getImportSpecifiers(file)) {
      const resolved = resolveProjectImport(file, specifier);
      if (resolved && fileSet.has(normalize(resolved))) {
        deps.push(normalize(resolved));
      }
    }
    graph.set(normalize(file), deps.sort());
  }
  return graph;
}

function findImportCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const activeStack: string[] = [];
  const visit = (file: string): void => {
    const activeIndex = activeStack.indexOf(file);
    if (activeIndex !== -1) {
      cycles.push([...activeStack.slice(activeIndex), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    activeStack.push(file);
    for (const dep of graph.get(file) ?? []) visit(dep);
    activeStack.pop();
  };
  for (const file of graph.keys()) visit(file);
  return cycles;
}

function stripSourceTextAndComments(source: string): string {
  const withoutStrings = source.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "");
  return withoutStrings
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("Import parser includes side-effect imports for cycle checks", () => {
  assert.deepEqual(
    getImportSpecifiersFromSource(
      [
        "import type { A } from './a.ts';",
        "import { b } from './b.ts';",
        "import './side-effect.ts';",
        "export { c } from './c.ts';",
        "const module = await import('./dynamic.ts');",
      ].join("\n"),
    ).sort(),
    ["./a.ts", "./b.ts", "./c.ts", "./dynamic.ts", "./side-effect.ts"],
  );
});

test("Source-only invariant scans ignore strings and comments", () => {
  assert.equal(
    stripSourceTextAndComments(
      [
        "const text = '=> process.env pi.';",
        "// interface Example extends Other {}",
        "/* function helper() { return process.env; } */",
        "const value = 1;",
      ].join("\n"),
    ).trim(),
    "const text = ;\n\n\nconst value = 1;",
  );
});

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

test("Node eval readiness bounds startup separately from execution and actual drain", async () => {
  const result = await runNodeEval('await new Promise(resolve => setTimeout(resolve, 700)); console.log("fixture-ready"); console.log("after-ready");', {
    timeoutMs: 500, readiness: { stdoutPrefix: "fixture-ready", startupTimeoutMs: 3000 },
  });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /after-ready/u);
  const started = performance.now();
  await assert.rejects(runNodeEval('console.log("fixture-ready"); setInterval(() => console.log("fixture-ready"), 100);', {
    timeoutMs: 500, readiness: { stdoutPrefix: "fixture-ready", startupTimeoutMs: 3000 },
  }), /did not exit \(execution\/drain\)/u);
  assert.ok(performance.now() - started < 3000, "Extra startup allowance cannot conceal post-ready retained handles or marker renewal");
  const integration = readFileSync(join(PROJECT_ROOT, "tests", "integration.test.ts"), "utf8");
  const start = integration.indexOf('test(`Production follower SDK first-send refuses foreign native carrier before ownership');
  const end = integration.indexOf('test(`Production follower question root keeps physical ACK', start);
  assert.ok(start >= 0 && end > start);
  const follower = integration.slice(start, end);
  assert.match(follower, /timeoutMs: 20000,\s*readiness: \{ stdoutPrefix: "follower-carrier-phase:import-complete:", startupTimeoutMs: 20000 \}/u,
    "Follower cold startup must be bounded separately from the original twenty-second work/drain guard");
  assert.match(follower, /\}, 45000\);/u, "The outer guard must retain only five seconds beyond the fixed forty-second child total");
  const imports = follower.indexOf('phase("import-complete");');
  assert.ok(imports > follower.indexOf('await import(base + "extension" + suffix)'));
  assert.ok(imports < follower.indexOf('extension(leader.pi)'), "Cold startup cannot hide a Root connection or semantic execution");
});

test("Node eval readiness refuses missing checkpoints within its startup bound", async () => {
  await assert.rejects(runNodeEval('setInterval(() => {}, 1000);', {
    timeoutMs: 1000, readiness: { stdoutPrefix: "fixture-ready", startupTimeoutMs: 300 },
  }), /did not exit \(startup\)/u);
  await assert.rejects(runNodeEval('console.log("not-ready");', {
    timeoutMs: 500, readiness: { stdoutPrefix: "fixture-ready", startupTimeoutMs: 3000 },
  }), /closed before readiness/u);
});

test("Domain test filenames mirror their owning lib domain", () => {
  const libDomains = new Set(
    readdirSync(join(PROJECT_ROOT, "lib"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.replace(/\.ts$/, "")),
  );
  const nonLibTestDomains = new Set([
    "dependency-audit",
    "index",
    "integration",
    "invariants",
    "process-shutdown",
    "public-api",
  ]);
  const unmirrored = readdirSync(join(PROJECT_ROOT, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.replace(/\.test\.ts$/, ""))
    .filter(
      (domain) => !libDomains.has(domain) && !nonLibTestDomains.has(domain),
    );

  assert.deepEqual(unmirrored, []);
});

test("Project source imports stay acyclic", () => {
  const graph = buildProjectImportGraph(getProjectSourceFiles());
  const cycles = findImportCycles(graph);

  assert.deepEqual(
    cycles,
    [],
    "Import cycles found:\n" + cycles.map((c) => c.join(" -> ")).join("\n"),
  );
});

test("Project no longer has shared constants or transport-type domains", () => {
  assert.equal(existsSync(join(PROJECT_ROOT, "lib", "constants.ts")), false);
  assert.equal(existsSync(join(PROJECT_ROOT, "lib", "types.ts")), false);
});

test("Preview domain stays independent from UI/compat rendering", () => {
  assert.equal(
    getImportSpecifiers(join("lib", "preview.ts")).includes("./rendering.ts"),
    false,
  );
});

test("Package exports expose only stable public domains", () => {
  const packageJson = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { exports?: Record<string, { types: string; default: string }> };

  assert.deepEqual(packageJson.exports, {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./inbound": { types: "./dist/api/inbound.d.ts", default: "./dist/api/inbound.js" },
    "./outbound": { types: "./dist/api/outbound.d.ts", default: "./dist/api/outbound.js" },
    "./delivery": { types: "./dist/api/delivery.d.ts", default: "./dist/api/delivery.js" },
    "./activity": { types: "./dist/api/activity.d.ts", default: "./dist/api/activity.js" },
    "./updates": { types: "./dist/api/updates.d.ts", default: "./dist/api/updates.js" },
    "./commands": { types: "./dist/api/commands.d.ts", default: "./dist/api/commands.js" },
    "./sections": { types: "./dist/api/sections.d.ts", default: "./dist/api/sections.js" },
    "./status": { types: "./dist/api/status.d.ts", default: "./dist/api/status.js" },
    "./voice": { types: "./dist/api/voice.d.ts", default: "./dist/api/voice.js" },
    "./keyboard": { types: "./dist/api/keyboard.d.ts", default: "./dist/api/keyboard.js" },
  });
});

test("Supported package boundaries do not expose journal mutation factories", () => {
  const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  assert.equal(Object.keys(packageJson.exports ?? {}).some(key => /journal/u.test(key)), false);
  const publicSources = ["index.ts", ...readdirSync(join(PROJECT_ROOT, "api"))
    .filter(file => file.endsWith(".ts")).map(file => join("api", file))]
    .map(file => readFileSync(join(PROJECT_ROOT, file), "utf8")).join("\n");
  assert.doesNotMatch(publicSources,
    /createTelegram(?:Input|Update)JournalStore|Telegram(?:Input|Update)JournalStore/u);
});

test("Project TypeScript files start with responsibility headers", () => {
  const filesWithoutHeaders = getProjectTypeScriptFiles().filter((file) => {
    return !readFileSync(join(PROJECT_ROOT, file), "utf8").startsWith("/**");
  });
  assert.deepEqual(filesWithoutHeaders, []);
});

test("Project source module headers include Domain DAG zone tags", () => {
  const sourceFilesWithoutZoneTags = getProjectSourceFiles().filter((file) => {
    const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
    const header = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
    return !/^ \* Zones: .+/m.test(header);
  });
  assert.deepEqual(sourceFilesWithoutZoneTags, []);
});

test("Project source avoids empty interface-extension shells", () => {
  const emptyInterfacePattern =
    /export\s+interface\s+\w+(?:<[^>{}]+>)?\s+extends[^{]+\{\s*\}/g;
  const emptyInterfaceExtensions = getProjectSourceFiles().flatMap((file) => {
    const source = stripSourceTextAndComments(
      readFileSync(join(PROJECT_ROOT, file), "utf8"),
    );
    return [...source.matchAll(emptyInterfacePattern)].map(
      (match) => `${file}: ${match[0].replace(/\s+/g, " ")}`,
    );
  });
  assert.deepEqual(emptyInterfaceExtensions, []);
});

test("Pi SDK imports stay centralized in the pi adapter and entrypoint-only host leaf", () => {
  const hostLeaf = normalize(join("lib", "pi-host.ts"));
  const directSdkImportFiles = getProjectSourceFiles().filter((file) => {
    if (file === normalize(join("lib", "pi.ts")) || file === hostLeaf) return false;
    const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
    const piSdkPackages = [
      "@mariozechner/pi-coding-agent",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
    ];
    return piSdkPackages.some((packageName) => source.includes(packageName));
  });
  assert.deepEqual(directSdkImportFiles, []);
  assert.deepEqual(getImportSpecifiers(hostLeaf), ["@earendil-works/pi-coding-agent"]);
  const hostConsumers = getProjectSourceFiles().filter(file =>
    getImportSpecifiers(file).some(specifier => specifier.endsWith("/pi-host.ts")));
  assert.deepEqual(hostConsumers, ["index.ts"]);
});

test("Entrypoint stays free of direct Node runtime imports", () => {
  const nodeImportSpecifiers = getImportSpecifiers("index.ts").filter(
    (specifier) => specifier.startsWith("node:"),
  );
  assert.deepEqual(nodeImportSpecifiers, []);
});

test("Production journal writers remain scoped or lifecycle-owned", () => {
  const source = readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8");
  assert.equal((source.match(/binding\.journal\.appendBatch\(/gu) ?? []).length, 1);
  assert.match(source, /withTelegramResolvedUpdateJournalReference\(\{[\s\S]*?publishJournalCursor[\s\S]*?binding\.journal\.appendBatch/u);
  assert.match(source, /followerAdmissionLifecycleRuntime\.appendBatch\(updates\)/u);
  assert.doesNotMatch(source, /createTelegram(?:Input|Update)JournalStore\(/u);
});

test("Production profile-only storage callbacks cannot reinterpret profile names as agent directories", () => {
  const source = readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8");
  assert.match(source, /getStatePath: Paths\.resolveTelegramStatePath,/u);
  assert.match(source, /path: Paths\.resolveTelegramStatePath,/u);
  assert.match(source, /getLeaderJournalPath: telegramLeaderJournalPath\.resolve,/u);
  assert.doesNotMatch(source, /getPath: Paths\.resolveTelegramWorkspaceAdmissionPath[,\n]/u);
  assert.doesNotMatch(source, /getLeaderJournalPath: Paths\.resolveTelegramUpdateJournalPath[,\n]/u);
});

test("Production keeps custody cutover and operator authority disconnected", () => {
  const source = readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8");
  for (const forbidden of [
    "acquireJournalWriterClosure",
    "installJournalWriterProtocolMode",
    "executeTelegramInputCustodyWriterCutover",
    "executeTelegramInputCustodyMigrationCompletion",
    "authorizeLegacyCustodyDisposition",
    "authorizeJournalWriterProtocolClosure",
    "createTelegramInputCustodyLegacyDispositionRuntime",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("Production journal resolver reads remain scoped or lifecycle-owned", () => {
  const source = readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8");
  assert.doesNotMatch(source,
    /resolveTelegram\w*JournalBinding\(\)\?\.journal\.read/u);
  assert.ok((source.match(/withTelegramResolvedUpdateJournalReference\(/gu) ?? []).length >= 4);
  assert.match(source, /withJournalReference\(binding, operation\)/u);
  assert.match(source, /acquireSourceReference\(role, binding\)/u);
});

test("Extension composition stays free of local runtime adapters", () => {
  const source = stripSourceTextAndComments(
    readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8"),
  );
  const localFunctionDeclarations = [
    ...source.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+\w+/g),
  ].map((match) => match[0].trim());
  assert.deepEqual(localFunctionDeclarations, []);
  assert.equal(source.includes("=>"), false);
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("process.pid"), false);
  assert.equal(/\blet\s+\w+/.test(source), false);
  assert.equal(source.includes("new Map"), false);
  assert.equal(source.includes("new Set"), false);
  assert.equal(source.includes("!."), false);
  assert.equal(/\bpi\./.test(source), false);
  assert.equal(source.includes("Threads.createTelegramTopicTargetRenamer"), false);
  assert.match(source, /telegramBusLeaderRuntime\.renameLeaderThreadAdmitted\s*\(/u);
  assert.deepEqual(
    [
      "Queue.createTelegramQueueMutationController",
      "Queue.createTelegramQueueDispatchRuntime",
      "Queue.createTelegramQueueDispatchWatchdogRuntime",
      "Threads.createTelegramCurrentInstanceThreadRuntime",
      "Threads.createTelegramThreadStatusProjectionRuntime",
      "Sync.createTelegramManualThreadDisconnectHandler",
      "Sync.createTelegramSessionRestartThreadCleanupHandler",
      "Updates.createTelegramQueueHandoffReconciler",
      "Updates.createTelegramUpdateWorkerOwnerRuntime",
      "Updates.createTelegramUpdateAdmissionLifecycleAssembly",
    ].filter((factory) => source.includes(factory)),
    [],
  );
});

test("Inbound composition projects live forwarding authority instead of raw message-cache records", () => {
  const source = stripSourceTextAndComments(
    readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8"),
  );
  assert.match(source, /getMessageOwnership:\s*messageOwnershipRuntime\.getForwardOwnership/u);
  assert.doesNotMatch(source, /getMessageOwnership:\s*messageOwnershipRuntime\.store\.get/u);
});

test("Visible thread identity never falls back directly to bare slot labels", () => {
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bthreadName\s*\?\?\s*slot\b/g, "threadName ?? slot"],
    [
      /\brecord\.threadName\s*\?\?\s*record\.slot\b/g,
      "record.threadName ?? record.slot",
    ],
    [/\?\s*[\w.]+\.threadName\s*:\s*[\w.]+\.slot\b/g, "ternary slot fallback"],
  ];
  const violations = getProjectSourceFiles().flatMap((file) => {
    const source = stripSourceTextAndComments(
      readFileSync(join(PROJECT_ROOT, file), "utf8"),
    );
    return forbiddenPatterns.flatMap(([pattern, label]) =>
      [...source.matchAll(pattern)].map(
        (match) => `${file}: ${label}: ${match[0].replace(/\s+/g, " ")}`,
      ),
    );
  });

  assert.deepEqual(violations, []);
});

test("Automatic Workspace retirement stays disconnected from production composition", () => {
  const compositionSource = stripSourceTextAndComments(
    readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8"),
  );
  assert.match(
    compositionSource,
    /createTelegramWorkspaceAdmissionRuntimeBinding\s*\(/u,
  );
  assert.match(
    compositionSource,
    /getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  assert.match(
    compositionSource,
    /createTelegramBusFollowerPromotionHandler[\s\S]*?getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve[\s\S]*?startLeader/u,
  );
  assert.match(
    compositionSource,
    /staleTopicApiErrorRecoveryDeps\s*=\s*\{[\s\S]*?getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  assert.match(
    compositionSource,
    /workspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  assert.match(
    compositionSource,
    /createTelegramWorkspaceOperationRuntime[\s\S]*?getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  for (const factory of [
    "createTelegramObservedTopicLifecycleSyncHandler",
    "createTelegramInboundRouteRuntime",
    "createTelegramBusLeaderRuntimeAssembly",
    "createTelegramThreadDisconnectAssembly",
  ]) {
    assert.match(
      compositionSource,
      new RegExp(
        `${factory}[\\s\\S]*?runWorkspaceOperation:\\s*telegramWorkspaceOperationRuntime\\.run`,
        "u",
      ),
    );
  }
  assert.match(
    compositionSource,
    /getExternalReservedSlots:\s*function\s*\(\)/u,
  );
  const busLeaderSource = readFileSync(
    join(PROJECT_ROOT, "lib", "bus-leader.ts"),
    "utf8",
  );
  assert.match(
    busLeaderSource,
    /const provisionerPorts\s*=\s*\{[\s\S]*?runWorkspaceOperation,[\s\S]*?recordRuntimeEvent/u,
  );
  assert.match(
    busLeaderSource,
    /operationKind:\s*"workspace\.reconcile-follower-provision"/u,
  );
  const retirementSource = readFileSync(
    join(PROJECT_ROOT, "lib", "workspace-retirement.ts"),
    "utf8",
  );
  assert.match(retirementSource, /issueDeletionPermit\s*\(/u);
  assert.match(retirementSource, /input\.deleteForumTopic\s*\(/u);
  assert.match(
    retirementSource,
    /pruneTelegramWorkspaceJournalEvidence[\s\S]*?admission:\s*Pick<[\s\S]*?operationKind:\s*"workspace\.prune-journal-evidence"/u,
  );
  const productionRetirementEntrypoints = [
    "runTelegramWorkspaceRetirementLifecycle",
    "executeTelegramWorkspaceRetirement",
  ];
  const productionConsumers = getProjectSourceFiles().filter((file) => {
    if (file === join("lib", "workspace-retirement.ts")) return false;
    const source = stripSourceTextAndComments(
      readFileSync(join(PROJECT_ROOT, file), "utf8"),
    );
    return productionRetirementEntrypoints.some((entrypoint) =>
      new RegExp(`\\b${entrypoint}\\b`, "u").test(source),
    );
  });
  assert.deepEqual(productionConsumers, []);
  assert.match(compositionSource, /workspaceRotation:\s*\{[\s\S]*?getAdmission:\s*workspaceAdmissionRuntime\.resolve,[\s\S]*?runExclusive:\s*telegramWorkspaceOperationRuntime\.runExclusive,[\s\S]*?deleteThread:\s*directTelegramApiRuntime\.deleteWorkspaceThread/u);
  assert.match(busLeaderSource, /createTelegramWorkspaceSlotRotation\s*\(/u);
  assert.match(busLeaderSource, /!restoringWorkspace && deps\.runWithWorkspaceCapacity/u);
});

test("Runtime state domain imports only the leaf machine runner", () => {
  const localImportSpecifiers = getImportSpecifiers(
    join("lib", "runtime.ts"),
  ).filter((specifier) => specifier.startsWith("."));
  // The runner imports nothing local (see the leaf test), so runtime stays free of domain logic transitively.
  assert.deepEqual(localImportSpecifiers, ["./machine.ts"]);
});

test("Structural leaf domains stay free of local nominal imports", () => {
  const leafFiles = ["machine.ts", "polling.ts", "setup.ts", "status.ts"];
  const localImportsByFile = Object.fromEntries(
    leafFiles.map((file) => [
      join("lib", file),
      getImportSpecifiers(join("lib", file)).filter((specifier) =>
        specifier.startsWith("."),
      ),
    ]),
  );

  assert.deepEqual(localImportsByFile, {
    [join("lib", "machine.ts")]: [],
    [join("lib", "polling.ts")]: [],
    [join("lib", "setup.ts")]: [],
    [join("lib", "status.ts")]: [],
  });
});

test("Menu domain stays on structural ports and does not re-export model", () => {
  const menuImports = getImportSpecifiers(join("lib", "menu.ts"));
  assert.equal(menuImports.includes("./pi.ts"), false);
  const menuSource = readFileSync(join(PROJECT_ROOT, "lib", "menu.ts"), "utf8");
  assert.equal(
    /export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+["']\.\/model\.ts["']/.test(
      menuSource,
    ),
    false,
  );
});

test("Telegram API transport stays decoupled from persisted config defaults", () => {
  const apiImports = getImportSpecifiers(join("lib", "telegram-api.ts"));
  assert.equal(apiImports.includes("./config.ts"), false);
});

test("Structural update and media domains stay decoupled from concrete API transport shapes", () => {
  const structuralFiles = ["updates.ts", "media.ts"];
  const apiImportsByFile = Object.fromEntries(
    structuralFiles.map((file) => [
      join("lib", file),
      getImportSpecifiers(join("lib", file)).includes("./telegram-api.ts"),
    ]),
  );
  assert.deepEqual(apiImportsByFile, {
    [join("lib", "updates.ts")]: false,
    [join("lib", "media.ts")]: false,
  });
});

test("Core assistant output never constructs Telegram Thinking blocks", () => {
  for (const file of [
    "replies.ts",
    "preview.ts",
    "outbound-attachments.ts",
    "queue.ts",
  ]) {
    const source = readFileSync(join(PROJECT_ROOT, "lib", file), "utf8");
    assert.doesNotMatch(
      source,
      /tg-thinking|InputRichBlockThinking|type\s*:\s*["']thinking["']/,
      `${file} must not project hidden reasoning into Telegram Thinking blocks`,
    );
  }
});

test("Outbound attachment delivery stays decoupled from queue, inbound media, and API helpers", () => {
  const attachmentImports = getImportSpecifiers(
    join("lib", "outbound-attachments.ts"),
  );
  assert.equal(attachmentImports.includes("./queue.ts"), false);
  assert.equal(attachmentImports.includes("./media.ts"), false);
  assert.equal(attachmentImports.includes("./telegram-api.ts"), false);
});

test("Live-rebind command channel has no per-command wire or follower-owner aliases", () => {
  for (const file of ["bus.ts", "bus-follower.ts", "routing.ts", "bindings.ts", "extension.ts"]) {
    const source = readFileSync(join(PROJECT_ROOT, "lib", file), "utf8");
    assert.doesNotMatch(source, /\b(selectedStatus|TelegramBusSelectedStatusInput|TelegramBusLiveRebindStatusObservation|getStatusOwner|isSelectedStatusAvailable|isLiveRebindStatusEnabled|isLiveRebindHeldCommandEnabled)\b|live-thread-rebind-(status|held-command)-v1|observe-status|status-observed/,
      `${file} must use only the unified command marker, observation, capability and owner`);
  }
});

test("Weakened live-rebind cleanup protection stays confined to its own origin", () => {
  // The live veto and one-shot executor relax historical protection only for live-rebind cleanup; strict
  // temporary-tab, retirement, adoption and custody consumers must not reach them.
  const users = (pattern: RegExp) => readdirSync(join(PROJECT_ROOT, "lib")).filter(name => name.endsWith(".ts") &&
    pattern.test(readFileSync(join(PROJECT_ROOT, "lib", name), "utf8"))).sort();
  assert.deepEqual(users(/\bisWorkspaceLiveRebindCleanupTargetProtected\b/), ["routing.ts", "threads.ts"]);
  assert.deepEqual(users(/\bissueLiveRebindThreadCleanup\b/), ["routing.ts", "thread-reconciler.ts"]);
  // Raw source: the quote-stripping helper is not apostrophe-safe for prose comments in large modules.
  const routing = readFileSync(join(PROJECT_ROOT, "lib", "routing.ts"), "utf8");
  const start = routing.indexOf("async function inspectLiveRebindRecipient(");
  const end = routing.indexOf("const observeLiveRebindLeaderWork", start);
  assert.ok(start > 0 && end > start, "The live-rebind recipient owner remains a single locatable function");
  const outside = routing.slice(0, start) + routing.slice(end);
  assert.doesNotMatch(outside, /\b(isWorkspaceLiveRebindCleanupTargetProtected|issueLiveRebindThreadCleanup)\b/,
    "Only the live-rebind recipient owner consumes the weakened protection or its executor");
});

await test("Export audit resolves aliases, namespace access, public stars and JS consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-export-audit-"));
  try {
    for (const name of ["lib", "api", "tests", "scripts"]) await mkdir(join(root, name));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
      include: ["lib/**/*.ts"],
    }));
    await writeFile(join(root, "lib/sample.ts"), `
      export interface Local { ok: boolean }
      export interface External { ok: boolean }
      export type Unused = string;
      export const leaf = 1;
      export const read = (value: Local) => value.ok ? leaf : 0;
      export const publicValue = 2;
      export const namespaceAccess = 3;
      export const scriptOnly = 4;
      export const mentionedInText = 5;
      export const shadow = 6;
    `);
    await writeFile(join(root, "lib/public.ts"), "export const publicStar = 1;");
    await writeFile(join(root, "lib/namespace.ts"), "export const publicNamespaceValue = 1;");
    await writeFile(join(root, "api/sample.ts"), `
      export { publicValue as published } from "../lib/sample.ts";
      export * from "../lib/public.ts";
      export * as publicNamespace from "../lib/namespace.ts";
    `);
    await writeFile(join(root, "tests/consumer.ts"), `
      import type { External as ConsumerType } from "../lib/sample.ts";
      import * as sample from "../lib/sample.ts";
      const value: ConsumerType = { ok: true };
      console.log(value, sample["namespaceAccess"]);
      console.log(Object.keys(sample));
      const shadow = 7;
      console.log(shadow);
      const generated = 'import { mentionedInText } from "../lib/sample.ts"';
      console.log(generated);
    `);
    await writeFile(join(root, "scripts/consumer.mjs"), `
      import { scriptOnly as used } from "../lib/sample.ts";
      console.log(used);
    `);
    const script = join(PROJECT_ROOT, "scripts/audit-exports.mjs");
    const report = JSON.parse(execFileSync(process.execPath, [script, root], { encoding: "utf8" })) as {
      scannedSources: number;
      libExports: number;
      candidates: Array<{ file: string; name: string; typeOnly: boolean; localReferences: number; namespaceEscapes: string[] }>;
    };
    assert.equal(report.scannedSources, 6);
    assert.equal(report.libExports, 12);
    assert.deepEqual(report.candidates.map(row => row.name), ["Local", "Unused", "leaf", "read", "mentionedInText", "shadow"]);
    assert.equal(report.candidates.find(row => row.name === "Local")?.typeOnly, true);
    assert.equal(report.candidates.find(row => row.name === "leaf")?.localReferences, 1);
    assert.equal(report.candidates.find(row => row.name === "shadow")?.localReferences, 0);
    assert.equal(report.candidates.find(row => row.name === "mentionedInText")?.localReferences, 0);
    assert.ok(report.candidates.every(row => row.namespaceEscapes.length === 1 && row.namespaceEscapes[0] === "tests/consumer.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Callback toasts carry no emoji and no terminal period", () => {
  // Toasts are fleeting tooltips written in final form at their call site; no boundary rewrites them.
  const emoji = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
  const offenders: string[] = [];
  for (const name of readdirSync(join(PROJECT_ROOT, "lib")).filter((file) => file.endsWith(".ts"))) {
    const path = join("lib", name);
    const source = ts.createSourceFile(name, readFileSync(join(PROJECT_ROOT, path), "utf8"), ts.ScriptTarget.Latest, true);
    const constants = new Map<string, string>();
    const toasts: ts.Expression[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer))
        constants.set(node.name.text, node.initializer.text);
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        if (/(?:^|\.)answerCallbackQuery$/u.test(callee) && node.arguments[1]) toasts.push(node.arguments[1]);
        if (callee === "finalizePendingReroute" && node.arguments[3]) toasts.push(node.arguments[3]);
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "message" &&
        node.parent.properties.some((property) => property.getText(source) === 'kind: "finalizing"'))
        toasts.push(node.initializer);
      ts.forEachChild(node, walk);
    };
    walk(source);
    const texts = (node: ts.Expression): string[] => {
      if (ts.isParenthesizedExpression(node)) return texts(node.expression);
      if (ts.isConditionalExpression(node)) return [...texts(node.whenTrue), ...texts(node.whenFalse)];
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
      if (ts.isTemplateExpression(node)) return [node.getText(source).slice(1, -1)];
      if (ts.isIdentifier(node) && constants.has(node.text)) return [constants.get(node.text)!];
      return [];
    };
    for (const toast of toasts)
      for (const text of texts(toast))
        if (emoji.test(text) || /[^.]\.$/u.test(text))
          offenders.push(`${path}:${source.getLineAndCharacterOfPosition(toast.getStart(source)).line + 1} ${text}`);
  }
  assert.deepEqual(offenders, []);
});
