/**
 * Regression tests for disposable Telegram runtime recovery classification
 * Covers power-loss corruption and live-owner safety boundaries
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNodeEval } from "./fixtures/node-eval.ts";
import {
  classifyTelegramRuntimeRecovery,
  createTelegramPollingStartRecoveryHandler,
  recoverTelegramRuntimeState,
} from "../lib/recovery.ts";

function createRuntimePaths(): {
  dir: string;
  ownersPath: string;
  statePath: string;
  transactionPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-recovery-"));
  const ownersPath = join(dir, "owners.json");
  return {
    dir,
    ownersPath,
    statePath: join(dir, "state.json"),
    transactionPath: `${ownersPath}.transaction`,
  };
}

function writeTransactionOwner(
  transactionPath: string,
  input: { pid: number; generation?: string },
): void {
  const generation = input.generation ?? "9f85c61e-3f1a-49e6-a1dd-fd49511f9af0";
  mkdirSync(transactionPath);
  writeFileSync(
    join(transactionPath, `owner.${generation}.json`),
    JSON.stringify({ pid: input.pid, acquiredAtMs: 1000, generation }),
  );
}

test("Runtime recovery classification treats absent disposable state as clean", () => {
  const paths = createRuntimePaths();
  try {
    assert.deepEqual(
      classifyTelegramRuntimeRecovery({
        ownersPath: paths.ownersPath,
        statePaths: [paths.statePath],
        isProcessAlive: () => false,
      }),
      { kind: "clean" },
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery classification accepts truncated owners.json for recovery", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.ownersPath, "{truncated");
    const result = classifyTelegramRuntimeRecovery({
      ownersPath: paths.ownersPath,
      statePaths: [paths.statePath],
      isProcessAlive: () => false,
    });
    assert.equal(result.kind, "recoverable-corruption");
    assert.deepEqual(
      result.kind === "recoverable-corruption"
        ? result.artifacts.map((artifact) => artifact.kind)
        : [],
      ["owners"],
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery classification refuses malformed state reset while an owner is live", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(
      paths.ownersPath,
      JSON.stringify({ telegram: { pid: 44, cwd: "/live" } }),
    );
    writeFileSync(paths.statePath, "{truncated");
    assert.deepEqual(
      classifyTelegramRuntimeRecovery({
        ownersPath: paths.ownersPath,
        statePaths: [paths.statePath],
        isProcessAlive: (pid) => pid === 44,
      }),
      {
        kind: "blocked-live-owner",
        artifacts: [
          {
            kind: "state",
            path: paths.statePath,
            reason: "state.json is not valid JSON",
          },
        ],
        livePids: [44],
      },
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery ignores a stale owner heartbeat even when its pid was reused", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(
      paths.ownersPath,
      JSON.stringify({
        telegram: { pid: 44, cwd: "/before-reboot", heartbeatMs: 1000 },
      }),
    );
    writeFileSync(paths.statePath, "{truncated");
    assert.equal(
      classifyTelegramRuntimeRecovery({
        ownersPath: paths.ownersPath,
        statePaths: [paths.statePath],
        isProcessAlive: (pid) => pid === 44,
        nowMs: 9001,
        staleHeartbeatMs: 8000,
      }).kind,
      "recoverable-corruption",
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery classification accepts malformed transaction debris for recovery", () => {
  const paths = createRuntimePaths();
  try {
    mkdirSync(paths.transactionPath);
    writeFileSync(
      join(paths.transactionPath, "owner.invalid.json"),
      "{truncated",
    );
    const result = classifyTelegramRuntimeRecovery({
      ownersPath: paths.ownersPath,
      transactionPath: paths.transactionPath,
      isProcessAlive: () => false,
    });
    assert.equal(result.kind, "recoverable-corruption");
    assert.deepEqual(
      result.kind === "recoverable-corruption"
        ? result.artifacts.map((artifact) => artifact.kind)
        : [],
      ["transaction"],
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery classification trusts a verifiable live transaction holder", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.statePath, "{truncated");
    writeTransactionOwner(paths.transactionPath, { pid: 55 });
    const result = classifyTelegramRuntimeRecovery({
      ownersPath: paths.ownersPath,
      statePaths: [paths.statePath],
      transactionPath: paths.transactionPath,
      isProcessAlive: (pid) => pid === 55,
    });
    assert.equal(result.kind, "blocked-live-owner");
    assert.deepEqual(
      result.kind === "blocked-live-owner" ? result.livePids : [],
      [55],
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery classification does not let a dead transaction holder block recovery", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.statePath, "{truncated");
    writeTransactionOwner(paths.transactionPath, { pid: 66 });
    assert.equal(
      classifyTelegramRuntimeRecovery({
        ownersPath: paths.ownersPath,
        statePaths: [paths.statePath],
        transactionPath: paths.transactionPath,
        isProcessAlive: () => false,
      }).kind,
      "recoverable-corruption",
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery classification rejects mismatched transaction generations", () => {
  const paths = createRuntimePaths();
  try {
    const generation = "9f85c61e-3f1a-49e6-a1dd-fd49511f9af0";
    mkdirSync(paths.transactionPath);
    writeFileSync(
      join(paths.transactionPath, `owner.${generation}.json`),
      JSON.stringify({
        pid: 77,
        acquiredAtMs: 1000,
        generation: "different-generation",
      }),
    );
    const result = classifyTelegramRuntimeRecovery({
      ownersPath: paths.ownersPath,
      transactionPath: paths.transactionPath,
      isProcessAlive: () => true,
    });
    assert.equal(result.kind, "recoverable-corruption");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery quarantines only corrupt disposable artifacts", () => {
  const paths = createRuntimePaths();
  try {
    const configPath = join(paths.dir, "telegram.json");
    const logsPath = join(paths.dir, "logs.jsonl");
    writeFileSync(paths.ownersPath, "{truncated");
    writeFileSync(paths.statePath, "{truncated");
    writeFileSync(configPath, JSON.stringify({ botToken: "preserved" }));
    writeFileSync(logsPath, "diagnostic\n");
    mkdirSync(paths.transactionPath);
    writeFileSync(
      join(paths.transactionPath, "owner.invalid.json"),
      "{truncated",
    );

    const result = recoverTelegramRuntimeState({
      ownersPath: paths.ownersPath,
      statePaths: [paths.statePath],
      transactionPath: paths.transactionPath,
      isProcessAlive: () => false,
      pid: 88,
      getNowMs: () => 1234,
    });
    assert.equal(result.kind, "recovered");
    assert.deepEqual(
      result.kind === "recovered"
        ? result.artifacts.map((artifact) => artifact.kind).sort()
        : [],
      ["owners", "state", "transaction"],
    );
    assert.equal(existsSync(paths.ownersPath), false);
    assert.equal(existsSync(paths.statePath), false);
    assert.equal(existsSync(paths.transactionPath), false);
    assert.equal(
      readFileSync(configPath, "utf8"),
      JSON.stringify({ botToken: "preserved" }),
    );
    assert.equal(readFileSync(logsPath, "utf8"), "diagnostic\n");
    if (result.kind === "recovered") {
      assert.deepEqual(readdirSync(result.quarantineDir).sort(), [
        "owners.json",
        "owners.json.transaction",
        "state.json",
      ]);
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery retries transient Windows quarantine rename failures", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.ownersPath, "{truncated");
    let renameAttempts = 0;
    const result = recoverTelegramRuntimeState({
      ownersPath: paths.ownersPath,
      statePaths: [paths.statePath],
      isProcessAlive: () => false,
      quarantineRename: (sourcePath, destinationPath) => {
        renameAttempts += 1;
        if (renameAttempts < 3) {
          throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
        }
        renameSync(sourcePath, destinationPath);
      },
      quarantineRenameRetryDelayMs: 0,
    });
    assert.equal(result.kind, "recovered");
    assert.equal(renameAttempts, 3);
    assert.equal(existsSync(paths.ownersPath), false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery refuses mutation while a proven owner is live", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(
      paths.ownersPath,
      JSON.stringify({ telegram: { pid: 99, cwd: "/live" } }),
    );
    writeFileSync(paths.statePath, "{truncated");
    assert.deepEqual(
      recoverTelegramRuntimeState({
        ownersPath: paths.ownersPath,
        statePaths: [paths.statePath],
        isProcessAlive: (pid) => pid === 99,
      }),
      { kind: "blocked-live-owner", livePids: [99] },
    );
    assert.equal(readFileSync(paths.statePath, "utf8"), "{truncated");
    assert.equal(existsSync(join(paths.dir, "recovery")), false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery never mistakes a current-process owner for its transaction guard", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(
      paths.ownersPath,
      JSON.stringify({ telegram: { pid: process.pid, cwd: "/still-active" } }),
    );
    writeFileSync(paths.statePath, "{truncated");
    const result = recoverTelegramRuntimeState({
      ownersPath: paths.ownersPath,
      statePaths: [paths.statePath],
      isProcessAlive: (pid) => pid === process.pid,
    });
    assert.equal(result.kind, "blocked-live-owner");
    assert.equal(readFileSync(paths.statePath, "utf8"), "{truncated");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery revalidates live ownership under the ownership transaction", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(
      paths.ownersPath,
      JSON.stringify({ telegram: { pid: 111, cwd: "/racing" } }),
    );
    writeFileSync(paths.statePath, "{truncated");
    let ownerChecks = 0;
    const result = recoverTelegramRuntimeState({
      ownersPath: paths.ownersPath,
      statePaths: [paths.statePath],
      isProcessAlive: (pid) => {
        if (pid !== 111) return pid === process.pid;
        ownerChecks += 1;
        return ownerChecks > 1;
      },
    });
    assert.equal(result.kind, "blocked-live-owner");
    assert.equal(readFileSync(paths.statePath, "utf8"), "{truncated");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Polling-start recovery blocks mutation when polling cannot stop safely", async () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.ownersPath, "{truncated");
    writeFileSync(paths.statePath, "{truncated");
    const events: Array<{ category: string; phase?: unknown }> = [];
    const recover = createTelegramPollingStartRecoveryHandler({
      getOwnersPath: () => paths.ownersPath,
      getStatePaths: () => [paths.statePath],
      suspendPolling: async () => {
        throw new Error("poller still active");
      },
      recordRuntimeEvent: (category, _error, details) => {
        events.push({ category, phase: details?.phase });
      },
    });

    const result = await recover();

    assert.equal(result.kind, "blocked");
    assert.match(
      result.kind === "blocked" ? result.message : "",
      /could not stop safely/,
    );
    assert.equal(readFileSync(paths.ownersPath, "utf8"), "{truncated");
    assert.equal(readFileSync(paths.statePath, "utf8"), "{truncated");
    assert.deepEqual(events, [
      { category: "recovery", phase: "suspend-before-reset" },
    ]);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Polling-start recovery continues after suspension when corrupt owners prevent release", async () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.ownersPath, "{truncated");
    const phases: unknown[] = [];
    const recover = createTelegramPollingStartRecoveryHandler({
      getOwnersPath: () => paths.ownersPath,
      getStatePaths: () => [paths.statePath],
      suspendPolling: async () => undefined,
      releaseOwnership: () => {
        throw new SyntaxError("truncated owners.json");
      },
      recordRuntimeEvent: (_category, _error, details) => {
        phases.push(details?.phase);
      },
    });

    const result = await recover();

    assert.equal(result.kind, "retry");
    assert.equal(existsSync(paths.ownersPath), false);
    assert.deepEqual(phases, ["release-before-reset"]);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery becomes a no-op after the first successful repair", () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.ownersPath, "{truncated");
    const input = {
      ownersPath: paths.ownersPath,
      statePaths: [paths.statePath],
      isProcessAlive: () => false,
    };
    assert.equal(recoverTelegramRuntimeState(input).kind, "recovered");
    assert.deepEqual(recoverTelegramRuntimeState(input), { kind: "not-needed" });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Runtime recovery leaves corruption retryable when quarantine creation fails", () => {
  const paths = createRuntimePaths();
  try {
    const invalidQuarantineRoot = join(paths.dir, "not-a-directory");
    writeFileSync(paths.ownersPath, "{truncated");
    writeFileSync(invalidQuarantineRoot, "occupied");
    assert.throws(
      () =>
        recoverTelegramRuntimeState({
          ownersPath: paths.ownersPath,
          statePaths: [paths.statePath],
          quarantineRoot: invalidQuarantineRoot,
          isProcessAlive: () => false,
        }),
      /not-a-directory|ENOTDIR|EEXIST/u,
    );
    assert.equal(readFileSync(paths.ownersPath, "utf8"), "{truncated");
    assert.equal(
      recoverTelegramRuntimeState({
        ownersPath: paths.ownersPath,
        statePaths: [paths.statePath],
        isProcessAlive: () => false,
      }).kind,
      "recovered",
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Concurrent process recovery elects one mutator for malformed runtime state", async () => {
  const paths = createRuntimePaths();
  try {
    writeFileSync(paths.ownersPath, "{truncated");
    writeFileSync(paths.statePath, "{truncated");
    mkdirSync(paths.transactionPath);
    writeFileSync(
      join(paths.transactionPath, "owner.invalid.json"),
      "{truncated",
    );
    const readyPaths = [join(paths.dir, "ready-1"), join(paths.dir, "ready-2")];
    const startPath = join(paths.dir, "start");
    const moduleUrl = new URL("../lib/recovery.ts", import.meta.url).href;
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { recoverTelegramRuntimeState } from ${JSON.stringify(moduleUrl)};
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      writeFileSync(process.env.READY_PATH, "ready");
      while (!existsSync(process.env.START_PATH)) sleep(2);
      const result = recoverTelegramRuntimeState({
        ownersPath: process.env.OWNERS_PATH,
        statePaths: [process.env.STATE_PATH],
        isProcessAlive: (pid) => {
          try { process.kill(pid, 0); return true; } catch { return false; }
        },
      });
      process.stdout.write(JSON.stringify({ kind: result.kind }));
    `;
    const children = readyPaths.map((readyPath) =>
      runNodeEval(source, {
        env: {
          OWNERS_PATH: paths.ownersPath,
          STATE_PATH: paths.statePath,
          READY_PATH: readyPath,
          START_PATH: startPath,
        },
        timeoutMs: 10_000,
      }),
    );
    const deadline = Date.now() + 2000;
    while (
      !readyPaths.every((readyPath) => existsSync(readyPath)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      readyPaths.every((readyPath) => existsSync(readyPath)),
      true,
      "children did not reach the recovery race barrier",
    );
    writeFileSync(startPath, "start");
    const results = await Promise.all(children);
    assert.deepEqual(
      results.map((result) => result.code),
      [0, 0],
      results.map((result) => result.stderr).join("\n"),
    );
    assert.deepEqual(
      results
        .map((result) => JSON.parse(result.stdout) as { kind: string })
        .map((result) => result.kind)
        .sort(),
      ["not-needed", "recovered"],
    );
    assert.equal(existsSync(paths.ownersPath), false);
    assert.equal(existsSync(paths.statePath), false);
    assert.equal(existsSync(paths.transactionPath), false);
    assert.equal(readdirSync(join(paths.dir, "recovery")).length, 1);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
