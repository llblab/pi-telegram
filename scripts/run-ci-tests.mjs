/**
 * Deterministic CI test allocation without changing per-test deadlines.
 * Zones: CI, test execution
 * Partitions domain files and integration registrations, isolating real-process tests on macOS.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const [phase, shard, mode, ...extra] = process.argv.slice(2);
if (!(["domains"].includes(phase) && ["all", "0", "1"].includes(shard) ||
      phase === "process" && ["0", "1"].includes(shard) ||
      phase === "integration" && ["0", "1", "2", "3"].includes(shard)) ||
    (mode !== undefined && mode !== "--list") || extra.length) {
  throw new Error("Usage: run-ci-tests.mjs <domains all|0|1 | process 0|1 | integration 0|1|2|3> [--list]");
}
const root = fileURLToPath(new URL("..", import.meta.url));
const entries = readdirSync(join(root, "tests"), { withFileTypes: true }).filter(entry => entry.name.endsWith(".test.ts"));
if (entries.some(entry => !entry.isFile())) throw new Error("The CI test inventory must contain only regular test files");
const names = entries.map(entry => entry.name).sort();
const integrationTest = "integration.test.ts", processTest = "process-shutdown.test.ts";
if (![integrationTest, processTest].every(name => names.includes(name))) throw new Error("Required CI test suites are missing");
const files = (phase === "integration" ? [integrationTest]
  : phase === "process" ? shard === "0" ? [processTest] : []
  : shard === "all" ? names.filter(name => name !== integrationTest)
  : names.filter(name => name !== integrationTest && name !== processTest).filter((_, index) => index % 2 === Number(shard)))
  .map(name => `tests/${name}`);
if (mode === "--list") console.log(JSON.stringify(files));
else if (files.length) {
  const env = { ...process.env, PATH: [join(root, "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(delimiter) };
  // A domain child must not inherit an integration-only filter from its caller.
  delete env.PI_TELEGRAM_INTEGRATION_SHARD; delete env.PI_TELEGRAM_INTEGRATION_LIST;
  if (phase === "integration") env.PI_TELEGRAM_INTEGRATION_SHARD = `${shard}/4`;
  console.log(`CI ${phase} ${shard}: ${files.length} test file(s)`);
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", "--import", "./tests/fixtures/canonical-tmpdir.ts",
    "--test", `--test-concurrency=${phase === "domains" && shard === "all" ? 4 : 1}`,
    // TAP publishes each integration failure with native details before a later test or job deadline can hide it.
    `--test-reporter=${phase === "integration" ? "tap" : phase === "process" ? "spec" : "dot"}`, ...files,
  ], { cwd: root, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.signal) console.error(`CI test child terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}
