/**
 * Bounded fresh-process sampling of recovery startup, never retry-until-green.
 * Zones: CI, test execution, diagnostic artifacts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pattern = String.raw`^Production separate OS roots retain original lifetimes across namespace loss \((?:(?:source|compiled)/(?:default|work)/damaged/refresh-cancel|compiled/work/false)\)$`;

export function runRecoveryDiagnostics({ rounds, outputDir, execute = spawnSync, env = process.env }) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20 || typeof outputDir !== "string" || !outputDir)
    throw new Error("Recovery diagnostics requires 1..20 rounds and an output directory.");
  const directory = resolve(outputDir);
  mkdirSync(directory, { recursive: true });
  const summaryPath = join(directory, "summary.json");
  const summary = { version: 1, complete: false, rounds, expectedTestsPerRound: 5,
    node: process.version, platform: process.platform, gitHubSha: env.GITHUB_SHA, attempts: [] };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  const childEnv = { ...env, PATH: [join(root, "node_modules", ".bin"), env.PATH].filter(Boolean).join(delimiter) };
  delete childEnv.PI_TELEGRAM_INTEGRATION_SHARD;
  delete childEnv.PI_TELEGRAM_INTEGRATION_LIST;
  for (let round = 1; round <= rounds; round++) {
    const name = `round-${String(round).padStart(3, "0")}`, started = Date.now();
    const roundDir = join(directory, name); mkdirSync(roundDir);
    let result;
    try {
      result = execute(process.execPath, ["--experimental-strip-types", "--import", "./tests/fixtures/canonical-tmpdir.ts",
        "--test", "--test-concurrency=1", "--test-reporter=tap", `--test-name-pattern=${pattern}`, "tests/integration.test.ts"],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        env: { ...childEnv, PI_TELEGRAM_RECOVERY_DIAGNOSTICS_DIR: roundDir } });
    } catch (error) { result = { status: null, signal: null, error }; }
    const redact = value => String(value ?? "").replaceAll("123:os-original", "<fixture-token>");
    const stdout = redact(result.stdout), stderr = redact(result.stderr);
    writeFileSync(join(roundDir, "stdout.log"), stdout);
    writeFileSync(join(roundDir, "stderr.log"), stderr);
    const tests = Number(/^# tests (\d+)\s*$/mu.exec(stdout)?.[1] ?? NaN);
    const passes = Number(/^# pass (\d+)\s*$/mu.exec(stdout)?.[1] ?? NaN);
    const failures = Number(/^# fail (\d+)\s*$/mu.exec(stdout)?.[1] ?? NaN);
    const passed = result.status === 0 && !result.signal && !result.error && tests === 5 && passes === 5 && failures === 0;
    summary.attempts.push({ round, passed, nativeExitCode: result.status ?? null, signal: result.signal ?? null,
      tests: Number.isFinite(tests) ? tests : null, passes: Number.isFinite(passes) ? passes : null,
      failures: Number.isFinite(failures) ? failures : null,
      durationMs: Date.now() - started, ...(result.error ? { error: redact(result.error.message ?? result.error) } : {}) });
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
    console.log(`Recovery observation ${round}/${rounds}: ${passed ? "PASS" : "FAIL"}; evidence=${roundDir}`);
  }
  summary.complete = true;
  summary.passed = summary.attempts.every(attempt => attempt.passed);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  return summary.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rounds, outputDir, ...extra] = process.argv.slice(2);
  if (!/^(?:[1-9]|1\d|20)$/u.test(rounds ?? "") || !outputDir || extra.length)
    throw new Error("Usage: run-recovery-diagnostics.mjs <1..20 rounds> <new output directory>");
  process.exitCode = runRecoveryDiagnostics({ rounds: Number(rounds), outputDir });
}
