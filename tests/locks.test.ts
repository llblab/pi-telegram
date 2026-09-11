/**
 * Regression tests for Telegram transport ownership helpers
 * Covers owners.json authority, stale-owner replacement, and owner-gated polling behavior
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { runNodeEval } from "./fixtures/node-eval.ts";
import {
  createTelegramLockedPollingRuntime,
  createTelegramLockKeyResolver,
  createTelegramLockRuntime,
  readLocks,
  resolveTelegramLockKey,
  TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
  TELEGRAM_LOCK_KEY,
  TELEGRAM_OWNERSHIP_CHECK_MS,
  TELEGRAM_OWNERSHIP_REFRESH_MS,
  withTelegramFileTransaction,
  writeLocks,
  type TelegramLockEntry,
} from "../lib/locks.ts";

function createTempLockPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-owners-"));
  return { dir, path: join(dir, "owners.json") };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (predicate()) return;
  assert.fail("Timed out waiting for condition");
}

interface LockRaceChild {
  result: Promise<{ ok: boolean; pid?: number }>;
}

function spawnLockRaceChild(input: {
  locksPath: string;
  key: string;
  readyPath: string;
  startPath: string;
}): LockRaceChild {
  const moduleUrl = new URL("../lib/locks.ts", import.meta.url).href;
  const source = `
    import { existsSync, writeFileSync } from "node:fs";
    import { createTelegramLockRuntime } from ${JSON.stringify(moduleUrl)};
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    writeFileSync(process.env.READY_PATH, "ready");
    while (!existsSync(process.env.START_PATH)) sleep(2);
    const lock = createTelegramLockRuntime({
      locksPath: process.env.LOCKS_PATH,
      key: process.env.LOCK_KEY,
    });
    const acquired = lock.acquire({ cwd: "/race" });
    process.stdout.write(JSON.stringify({ ok: acquired.ok, pid: acquired.ok ? acquired.lock.pid : undefined }));
    if (acquired.ok) sleep(300);
  `;
  const result = runNodeEval(source, {
    env: {
      LOCKS_PATH: input.locksPath,
      LOCK_KEY: input.key,
      READY_PATH: input.readyPath,
      START_PATH: input.startPath,
    },
  }).then(({ code, stdout, stderr }) => {
    if (code !== 0) throw new Error(`Lock race child exited ${code}: ${stderr}`);
    return JSON.parse(stdout) as { ok: boolean; pid?: number };
  });
  return { result };
}

test("Lock runtime commits side effects only under its exact transaction owner", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      instanceId: "runtime:first",
    });
    const acquired = first.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    let commits = 0;
    assert.equal(
      first.commitIfOwned(() => {
        commits += 1;
      }),
      true,
    );

    const replacement = createTelegramLockRuntime({
      locksPath: temp.path,
      instanceId: "runtime:replacement",
    });
    const replaced = replacement.acquire(
      { cwd: "/repo" },
      {
        force: true,
        expectedOwner: acquired.ok ? acquired.lock : undefined,
      },
    );
    assert.equal(replaced.ok, true);
    assert.equal(
      first.commitIfOwned(() => {
        commits += 1;
      }),
      false,
    );
    assert.equal(
      replacement.commitIfOwned(() => {
        commits += 1;
      }),
      true,
    );
    assert.equal(commits, 2);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime acquires, refreshes, and releases its own key", () => {
  const temp = createTempLockPath();
  try {
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.deepEqual(acquired, {
      ok: true,
      lock: { pid: 10, cwd: "/repo" },
      replacedStale: false,
    });
    assert.equal(lock.getStatusLabel(), "active here");
    assert.equal(lock.owns(), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(lock.release().kind, "active-here");
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Owner slot resolver uses local default and named profile keys", () => {
  let activeProfileName: string | undefined;
  const resolveKey = createTelegramLockKeyResolver({
    getActiveProfileName: () => activeProfileName,
  });

  assert.equal(resolveTelegramLockKey(), "default");
  assert.equal(resolveKey(), "default");
  activeProfileName = "omp";
  assert.equal(resolveKey(), "omp");
});

test("Lock runtime releases only the active profile key", () => {
  const temp = createTempLockPath();
  try {
    let activeProfileName: string | undefined = "work";
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      key: createTelegramLockKeyResolver({
        getActiveProfileName: () => activeProfileName,
      }),
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    activeProfileName = "omp";
    const other = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      key: createTelegramLockKeyResolver({
        getActiveProfileName: () => activeProfileName,
      }),
    });
    assert.equal(other.acquire({ cwd: "/repo" }).ok, true);

    assert.equal(other.release().kind, "active-here");
    assert.deepEqual(readLocks(temp.path).work, {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(readLocks(temp.path).omp, undefined);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("writeLocks writes private lock files", () => {
  const temp = createTempLockPath();
  try {
    writeLocks(temp.path, { [TELEGRAM_LOCK_KEY]: { pid: 10 } });
    if (process.platform !== "win32") {
      assert.equal(statSync(temp.path).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("File transaction publishes a private directory guard with owner metadata", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    withTelegramFileTransaction(transactionPath, () => {
      assert.equal(statSync(transactionPath).isDirectory(), true);
      if (process.platform !== "win32") {
        assert.equal(statSync(transactionPath).mode & 0o777, 0o700);
      }
      const ownerPath = join(transactionPath, readdirSync(transactionPath)[0]);
      if (process.platform !== "win32") {
        assert.equal(statSync(ownerPath).mode & 0o777, 0o600);
      }
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as {
        pid: number;
        acquiredAtMs: number;
        generation: string;
      };
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.acquiredAtMs, "number");
      assert.match(owner.generation, /^[0-9a-f-]{36}$/u);
    });
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("File transaction retries transient guard publication errors after contention disappears", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  let publishAttempts = 0;
  let operations = 0;
  try {
    withTelegramFileTransaction(
      transactionPath,
      () => {
        operations += 1;
      },
      {
        attempts: 2,
        retryDelayMs: 0,
        publishRename(fromPath, toPath) {
          publishAttempts += 1;
          if (publishAttempts === 1) {
            throw Object.assign(new Error("transient publication contention"), {
              code: "EPERM",
            });
          }
          renameSync(fromPath, toPath);
        },
      },
    );
    assert.equal(publishAttempts, 2);
    assert.equal(operations, 1);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers a directory guard left by a dead process", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-directory-guard.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-directory-guard",
      }),
      { mode: 0o600 },
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers dead directory main and recovery guards", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  try {
    for (const [path, generation] of [
      [transactionPath, "dead-main-directory"],
      [recoveryPath, "dead-recovery-directory"],
    ] as const) {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(
        join(path, `owner.${generation}.json`),
        JSON.stringify({
          pid: 2_147_483_647,
          acquiredAtMs: Date.now(),
          generation,
        }),
        { mode: 0o600 },
      );
    }
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
    assert.equal(existsSync(recoveryPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction releases recovered ownership when recovery cleanup fails", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  try {
    for (const [path, generation] of [
      [transactionPath, "dead-main-before-cleanup-failure"],
      [recoveryPath, "dead-recovery-before-cleanup-failure"],
    ] as const) {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(
        join(path, `owner.${generation}.json`),
        JSON.stringify({
          pid: 2_147_483_647,
          acquiredAtMs: Date.now(),
          generation,
        }),
        { mode: 0o600 },
      );
    }
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          recoveryRename(fromPath, toPath) {
            if (fromPath === recoveryPath) {
              throw Object.assign(new Error("injected recovery cleanup busy"), {
                code: "EBUSY",
              });
            }
            renameSync(fromPath, toPath);
          },
        }),
      /injected recovery cleanup busy/,
    );
    assert.equal(existsSync(transactionPath), false);
    withTelegramFileTransaction(transactionPath, () => undefined);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction rollback retry restores peer-process recovery", async () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const readyPath = join(temp.dir, "ready-peer");
  const startPath = join(temp.dir, "start-peer");
  let rollbackFailed = false;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-main-before-rename-failure.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-main-before-rename-failure",
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          recoveryRename(fromPath, toPath) {
            const isRollback = basename(String(fromPath)).startsWith(
              "owner.reclaim.",
            );
            if (
              fromPath === transactionPath ||
              (isRollback && !rollbackFailed)
            ) {
              if (isRollback) rollbackFailed = true;
              throw Object.assign(new Error("injected transient busy"), {
                code: "EBUSY",
              });
            }
            renameSync(fromPath, toPath);
          },
        }),
      /injected transient busy/,
    );
    assert.deepEqual(readdirSync(transactionPath), [
      "owner.dead-main-before-rename-failure.json",
    ]);
    const child = spawnLockRaceChild({
      locksPath: temp.path,
      key: TELEGRAM_LOCK_KEY,
      readyPath,
      startPath,
    });
    await waitForCondition(() => existsSync(readyPath), 2_000);
    writeFileSync(startPath, "start");
    assert.equal((await child.result).ok, true);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction reclaims an inactive same-process marker after rollback failure", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-main-before-rollback-failure.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-main-before-rollback-failure",
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          recoveryRename(fromPath, toPath) {
            if (
              fromPath === transactionPath ||
              basename(String(fromPath)).startsWith("owner.reclaim.")
            ) {
              throw Object.assign(new Error("injected rollback busy"), {
                code: "EBUSY",
              });
            }
            renameSync(fromPath, toPath);
          },
        }),
      AggregateError,
    );
    assert.match(readdirSync(transactionPath)[0], /^owner\.reclaim\./u);
    withTelegramFileTransaction(transactionPath, () => undefined);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovery preserves a live recovery guard", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  const liveRecoveryOwner = {
    pid: process.pid,
    acquiredAtMs: Date.now(),
    generation: "live-recovery-owner",
  };
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-main-with-live-recovery.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-main-with-live-recovery",
      }),
      { mode: 0o600 },
    );
    mkdirSync(recoveryPath, { mode: 0o700 });
    writeFileSync(
      join(recoveryPath, "owner.live-recovery-owner.json"),
      JSON.stringify(liveRecoveryOwner),
      { mode: 0o600 },
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(recoveryPath, "owner.live-recovery-owner.json"),
          "utf8",
        ),
      ),
      liveRecoveryOwner,
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers dead legacy main and recovery guards", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  try {
    for (const [path, generation] of [
      [transactionPath, "dead-main-legacy"],
      [recoveryPath, "dead-recovery-legacy"],
    ] as const) {
      writeFileSync(
        path,
        JSON.stringify({
          pid: 2_147_483_647,
          acquiredAtMs: Date.now(),
          generation,
        }),
        { mode: 0o600 },
      );
    }
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
    assert.equal(existsSync(recoveryPath), false);
    assert.equal(existsSync(`${recoveryPath}.migration`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction resumes a reclaim marker left by a dead recoverer", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(
        transactionPath,
        "owner.reclaim.2147483647.00000000-0000-4000-8000-000000000000.json",
      ),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-original-owner",
      }),
      { mode: 0o600 },
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("File transaction refuses to release a replacement directory owner", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => {
          rmSync(transactionPath, { recursive: true, force: true });
          mkdirSync(transactionPath, { mode: 0o700 });
          writeFileSync(
            join(transactionPath, "owner.replacement-owner.json"),
            JSON.stringify({
              pid: process.pid,
              acquiredAtMs: Date.now(),
              generation: "replacement-owner",
            }),
            { mode: 0o600 },
          );
        }),
      /changed ownership/,
    );
    assert.equal(existsSync(transactionPath), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Delayed stale recovery cannot claim a replacement generation", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const replacementOwner = {
    pid: process.pid,
    acquiredAtMs: Date.now(),
    generation: "replacement-generation",
  };
  let replaced = false;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.stale-generation.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "stale-generation",
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          attempts: 2,
          retryDelayMs: 0,
          recoveryRename(fromPath, toPath) {
            if (
              !replaced &&
              basename(String(fromPath)) === "owner.stale-generation.json"
            ) {
              replaced = true;
              rmSync(transactionPath, { recursive: true, force: true });
              mkdirSync(transactionPath, { mode: 0o700 });
              writeFileSync(
                join(transactionPath, "owner.replacement-generation.json"),
                JSON.stringify(replacementOwner),
                { mode: 0o600 },
              );
              throw Object.assign(
                new Error("injected macOS concurrent rename contention"),
                { code: "EINVAL" },
              );
            }
            renameSync(fromPath, toPath);
          },
        }),
      /Timed out acquiring Telegram lock transaction/,
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(transactionPath, "owner.replacement-generation.json"),
          "utf8",
        ),
      ),
      replacementOwner,
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers a guard left by a dead process", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      `${temp.path}.transaction`,
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-guard",
      }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(`${temp.path}.transaction`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction fails closed on an unverified guard", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(`${temp.path}.transaction`, "");
    assert.throws(
      () =>
        withTelegramFileTransaction(
          `${temp.path}.transaction`,
          () => undefined,
          { attempts: 2, retryDelayMs: 0 },
        ),
      /Timed out acquiring Telegram lock transaction/,
    );
    assert.equal(readFileSync(`${temp.path}.transaction`, "utf8"), "");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction fails closed on an unverified directory guard", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          attempts: 2,
          retryDelayMs: 0,
        }),
      /Timed out acquiring Telegram lock transaction/,
    );
    assert.equal(statSync(transactionPath).isDirectory(), true);
    assert.deepEqual(readdirSync(transactionPath), []);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction fails closed on malformed registry content", () => {
  const temp = createTempLockPath();
  try {
    const malformed = "{not-json";
    writeFileSync(temp.path, malformed);
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.throws(() => lock.acquire({ cwd: "/repo" }), SyntaxError);
    assert.equal(readFileSync(temp.path, "utf8"), malformed);
    assert.equal(existsSync(`${temp.path}.transaction`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction elects exactly one concurrent child process", async () => {
  const temp = createTempLockPath();
  const startPath = join(temp.dir, "start");
  const readyPaths = [join(temp.dir, "ready-a"), join(temp.dir, "ready-b")];
  try {
    const children = readyPaths.map((readyPath) =>
      spawnLockRaceChild({
        locksPath: temp.path,
        key: TELEGRAM_LOCK_KEY,
        readyPath,
        startPath,
      }),
    );
    await waitForCondition(
      () => readyPaths.every((readyPath) => existsSync(readyPath)),
      2_000,
    );
    writeFileSync(startPath, "start");
    const results = await Promise.all(children.map((child) => child.result));
    assert.equal(results.filter((result) => result.ok).length, 1);
    const persisted = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as {
      pid: number;
    };
    assert.equal(persisted.pid, results.find((result) => result.ok)?.pid);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Concurrent stale-guard recovery elects exactly one child process", async () => {
  const temp = createTempLockPath();
  const startPath = join(temp.dir, "start");
  const readyPaths = [join(temp.dir, "ready-a"), join(temp.dir, "ready-b")];
  try {
    const transactionPath = `${temp.path}.transaction`;
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-race-guard.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-race-guard",
      }),
      { mode: 0o600 },
    );
    const children = readyPaths.map((readyPath) =>
      spawnLockRaceChild({
        locksPath: temp.path,
        key: TELEGRAM_LOCK_KEY,
        readyPath,
        startPath,
      }),
    );
    await waitForCondition(
      () => readyPaths.every((readyPath) => existsSync(readyPath)),
      2_000,
    );
    writeFileSync(startPath, "start");
    const results = await Promise.all(children.map((child) => child.result));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(existsSync(`${temp.path}.transaction`), false);
    assert.equal(existsSync(`${temp.path}.transaction.recovery`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction preserves keys acquired by concurrent profiles", async () => {
  const temp = createTempLockPath();
  const startPath = join(temp.dir, "start");
  const readyPaths = [join(temp.dir, "ready-a"), join(temp.dir, "ready-b")];
  const keys = [TELEGRAM_LOCK_KEY, "work"];
  try {
    const children = keys.map((key, index) =>
      spawnLockRaceChild({
        locksPath: temp.path,
        key,
        readyPath: readyPaths[index]!,
        startPath,
      }),
    );
    await waitForCondition(
      () => readyPaths.every((readyPath) => existsSync(readyPath)),
      2_000,
    );
    writeFileSync(startPath, "start");
    const results = await Promise.all(children.map((child) => child.result));
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    const persisted = readLocks(temp.path);
    assert.deepEqual(Object.keys(persisted).sort(), [...keys].sort());
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime preserves other profile owners and refuses a live default owner", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify(
        {
          work: { pid: 123 },
          [TELEGRAM_LOCK_KEY]: { pid: 99 },
        },
        null,
        2,
      ),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, false);
    assert.equal(lock.getStatusLabel(), "active elsewhere (pid 99)");
    assert.deepEqual(readLocks(temp.path).work, { pid: 123 });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime records bus leader metadata and refreshes heartbeat", () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => nowMs,
      mintLeaderEpoch: () => 1000,
      runtimeGeneration: 1,
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(lock.getOwnedLeaderEpoch(), 1000);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      heartbeatMs: 1000,
      leaderEpoch: 1000,
      runtimeGeneration: 1,
    });
    nowMs = 1500;
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      heartbeatMs: 1500,
      leaderEpoch: 1000,
      runtimeGeneration: 1,
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime fences refresh and release to the acquired owner epoch", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => 1000,
      mintLeaderEpoch: () => "epoch-a",
      runtimeGeneration: 1,
    });
    const second = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "inst-b",
      getNowMs: () => 2000,
      mintLeaderEpoch: () => "epoch-b",
      runtimeGeneration: 2,
      isProcessAlive: () => true,
    });
    const acquiredFirst = first.acquire({ cwd: "/repo" });
    assert.equal(acquiredFirst.ok, true);
    assert.equal(second.acquire({ cwd: "/repo" }).ok, false);
    assert.equal(
      second.acquire(
        { cwd: "/repo" },
        {
          force: true,
          expectedOwner: {
            pid: 10,
            cwd: "/repo",
            instanceId: "wrong-owner",
            leaderEpoch: "epoch-a",
          },
        },
      ).ok,
      false,
    );
    assert.equal(
      second.acquire(
        { cwd: "/repo" },
        {
          force: true,
          expectedOwner: acquiredFirst.ok ? acquiredFirst.lock : undefined,
        },
      ).ok,
      true,
    );

    assert.equal(first.getOwnedLeaderEpoch(), undefined);
    assert.equal(second.getOwnedLeaderEpoch(), "epoch-b");
    assert.equal(first.refresh({ cwd: "/repo" }), false);
    first.release();
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 11,
      cwd: "/repo",
      instanceId: "inst-b",
      heartbeatMs: 2000,
      leaderEpoch: "epoch-b",
      runtimeGeneration: 2,
    });
    assert.equal(second.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock election cannot replace an observed stale owner after its lease refreshes", () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    const leader = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 1,
      getNowMs: () => nowMs,
      mintLeaderEpoch: () => "leader-epoch",
      staleHeartbeatMs: 500,
    });
    assert.equal(leader.acquire({ cwd: "/repo" }).ok, true);
    const follower = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "follower",
      runtimeGeneration: 2,
      getNowMs: () => nowMs,
      staleHeartbeatMs: 500,
      isProcessAlive: () => true,
    });
    nowMs = 2000;
    const observed = follower.getState();
    assert.equal(observed.kind, "stale");
    nowMs = 2001;
    assert.equal(leader.refresh({ cwd: "/repo" }), true);
    const result = follower.acquire(
      { cwd: "/repo" },
      {
        election: true,
        expectedOwner: observed.kind === "stale" ? observed.lock : undefined,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(leader.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime applies the eight-second bus leader stale threshold", () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    const leader = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      getNowMs: () => nowMs,
      staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
    });
    assert.equal(leader.acquire({ cwd: "/leader" }).ok, true);
    const follower = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "follower",
      getNowMs: () => nowMs,
      staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
      isProcessAlive: () => true,
    });
    nowMs = 8999;
    assert.equal(follower.getState().kind, "active-elsewhere");
    nowMs = 9001;
    assert.equal(follower.getState().kind, "stale");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock election cannot replace an owner that appeared after inactive observation", () => {
  const temp = createTempLockPath();
  try {
    const leader = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 1,
    });
    const follower = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "follower",
      runtimeGeneration: 2,
      isProcessAlive: () => true,
    });
    assert.equal(follower.getState().kind, "inactive");
    assert.equal(leader.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(
      follower.acquire(
        { cwd: "/repo" },
        { election: true, expectedOwner: undefined },
      ).ok,
      false,
    );
    assert.equal(leader.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime mints collision-resistant epochs independently of heartbeat time", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => 1000,
    });
    const firstResult = first.acquire({ cwd: "/repo" });
    assert.equal(firstResult.ok, true);
    first.release();
    const second = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "inst-b",
      getNowMs: () => 1000,
    });
    const secondResult = second.acquire({ cwd: "/repo" });
    assert.equal(secondResult.ok, true);
    assert.equal(
      typeof (firstResult.ok && firstResult.lock.leaderEpoch),
      "string",
    );
    assert.notEqual(
      firstResult.ok ? firstResult.lock.leaderEpoch : undefined,
      secondResult.ok ? secondResult.lock.leaderEpoch : undefined,
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime upgrades adopted legacy ownership during refresh", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 7,
      getNowMs: () => 2000,
      mintLeaderEpoch: () => "epoch",
    });
    assert.equal(lock.owns({ cwd: "/repo" }), true);
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    assert.equal(lock.owns({ cwd: "/repo" }), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "leader",
      heartbeatMs: 2000,
      leaderEpoch: "epoch",
      runtimeGeneration: 7,
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime prunes legacy bus socket path on heartbeat refresh", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: {
          pid: 10,
          cwd: "/repo",
          instanceId: "inst-a",
          heartbeatMs: 1000,
          leaderEpoch: 1000,
          runtimeGeneration: 1,
          busSocketPath: join(temp.dir, "bus.sock"),
        },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      runtimeGeneration: 1,
      getNowMs: () => 1500,
    });
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      heartbeatMs: 1500,
      leaderEpoch: 1000,
      runtimeGeneration: 1,
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime treats stale bus heartbeats as replaceable even when pid is alive", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: {
          pid: 99,
          cwd: "/old",
          instanceId: "old-inst",
          heartbeatMs: 1000,
        },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => 3000,
      mintLeaderEpoch: () => 3000,
      runtimeGeneration: 1,
      staleHeartbeatMs: 500,
      isProcessAlive: (pid) => pid === 99,
    });
    assert.equal(lock.getState().kind, "stale");
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.ok && acquired.replacedStale, true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      heartbeatMs: 3000,
      leaderEpoch: 3000,
      runtimeGeneration: 1,
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Stale leader election admits one observed-owner candidate and fences the old leader", () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    const leader = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 1,
      getNowMs: () => nowMs,
      mintLeaderEpoch: () => "leader-epoch",
      staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
    });
    assert.equal(leader.acquire({ cwd: "/leader" }).ok, true);
    const createCandidate = (pid: number, instanceId: string) =>
      createTelegramLockRuntime({
        locksPath: temp.path,
        pid,
        instanceId,
        runtimeGeneration: pid,
        getNowMs: () => nowMs,
        mintLeaderEpoch: () => `${instanceId}-epoch`,
        staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
        isProcessAlive: () => true,
      });
    const first = createCandidate(11, "candidate-a");
    const second = createCandidate(12, "candidate-b");
    nowMs = 9001;
    const firstObservation = first.getState();
    const secondObservation = second.getState();
    assert.equal(firstObservation.kind, "stale");
    assert.equal(secondObservation.kind, "stale");
    assert.equal(
      first.acquire(
        { cwd: "/candidate-a" },
        {
          election: true,
          expectedOwner:
            firstObservation.kind === "stale"
              ? firstObservation.lock
              : undefined,
        },
      ).ok,
      true,
    );
    assert.equal(
      second.acquire(
        { cwd: "/candidate-b" },
        {
          election: true,
          expectedOwner:
            secondObservation.kind === "stale"
              ? secondObservation.lock
              : undefined,
        },
      ).ok,
      false,
    );
    assert.equal(first.owns({ cwd: "/candidate-a" }), true);
    assert.equal(second.owns({ cwd: "/candidate-b" }), false);
    assert.equal(leader.refresh({ cwd: "/leader" }), false);
    assert.equal(first.getOwnedLeaderEpoch(), "candidate-a-epoch");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime replaces stale owners", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99 } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: () => false,
    });
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.ok && acquired.replacedStale, true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime prevents inherited child sessions from polling the same agent dir", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const parentLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
    });
    const childLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      isProcessAlive: (pid) => pid === 10,
    });
    const parentRuntime = createTelegramLockedPollingRuntime({
      lock: parentLock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("parent:start");
      },
      stopPolling: async () => {
        events.push("parent:stop");
      },
      updateStatus: () => {
        events.push("parent:status");
      },
    });
    const childRuntime = createTelegramLockedPollingRuntime({
      lock: childLock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("child:start");
      },
      stopPolling: async () => {
        events.push("child:stop");
      },
      updateStatus: () => {
        events.push("child:status");
      },
    });
    assert.equal((await parentRuntime.start({ cwd: "/repo" })).ok, true);
    await childRuntime.onSessionStart({}, { cwd: "/repo" });
    const blocked = await childRuntime.start({ cwd: "/repo" });
    assert.deepEqual(blocked, {
      ok: false,
      canTakeover: true,
      owner: "pid 10, cwd /repo",
      message:
        "Telegram bridge is active in another Pi instance (pid 10, cwd /repo).",
    });
    assert.deepEqual(events, ["parent:start", "parent:status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(await parentRuntime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime registers as follower when another live owner blocks start", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: {
          pid: 99,
          cwd: "/old",
          instanceId: "owner-inst",
          busSocketPath: join(temp.dir, "bus.sock"),
        },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async (ctx, owner) => {
        events.push(
          `register:${ctx.cwd}:${owner.instanceId}:${owner.busSocketPath}`,
        );
        return true;
      },
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    const result = await runtime.start({ cwd: "/repo" });
    assert.equal(result.ok, true);
    assert.equal(result.canTakeover, false);
    assert.equal(result.message, undefined);
    assert.deepEqual(events, [
      `register:/repo:owner-inst:${join(temp.dir, "bus.sock")}`,
      "status",
    ]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime falls back to takeover when follower registration is not applicable", async () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async () => undefined,
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    const blocked = await runtime.start({ cwd: "/repo" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.canTakeover, true);
    assert.match(blocked.message, /active in another Pi instance/);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime records follower registration failures without blocking takeover prompt", async () => {
  const temp = createTempLockPath();
  try {
    const runtimeEvents: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async () => {
        throw new Error("register failed");
      },
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
      recordRuntimeEvent: (category, error, details) => {
        runtimeEvents.push(
          `${category}:${details?.phase}:${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
    const blocked = await runtime.start({ cwd: "/repo" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.canTakeover, false);
    assert.match(
      blocked.message,
      /follower registration failed: register failed/,
    );
    assert.deepEqual(runtimeEvents, ["bus:follower-register:register failed"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime diagnoses a live owner with unreachable bus endpoint", async () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async () => {
        throw new Error("connect ENOENT /agent/tmp/telegram/bus.sock");
      },
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    const blocked = await runtime.start({ cwd: "/repo" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.canTakeover, false);
    assert.match(
      blocked.message,
      /live owner \/ unreachable bus endpoint after bounded retries/,
    );
    assert.match(blocked.message, /retry \/telegram-connect/);
    assert.match(blocked.message, /Do not force takeover/);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime stops follower heartbeat on stop", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      stopFollowerRegistration: () => {
        events.push("follower:stop");
      },
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("poll:stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    assert.equal((await runtime.start({ cwd: "/repo" })).ok, true);
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
    assert.deepEqual(events, ["start", "status", "follower:stop", "poll:stop"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime can force takeover of live polling owners", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    const blocked = await runtime.start({ cwd: "/new" });
    assert.deepEqual(blocked, {
      ok: false,
      canTakeover: true,
      owner: "pid 99, cwd /old",
      message:
        "Telegram bridge is active in another Pi instance (pid 99, cwd /old).",
    });
    const moved = await runtime.start({ cwd: "/new" }, { force: true });
    assert.deepEqual(moved, {
      ok: true,
      message: "Telegram bridge connected.",
    });
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/new",
    });
    assert.deepEqual(events, ["start", "status"]);
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime hands same-process ownership to a replacement instance", async () => {
  const temp = createTempLockPath();
  try {
    const previousLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "old-instance",
      mintLeaderEpoch: () => "old-epoch",
    });
    assert.equal(previousLock.acquire({ cwd: "/repo" }).ok, true);
    const replacementLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "new-instance",
      mintLeaderEpoch: () => "new-epoch",
    });
    const events: string[] = [];
    const runtime = createTelegramLockedPollingRuntime({
      lock: replacementLock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    assert.deepEqual(await runtime.start({ cwd: "/repo" }), {
      ok: true,
      message: "Telegram bridge connected.",
    });
    assert.equal(previousLock.refresh({ cwd: "/repo" }), false);
    previousLock.release();
    const persisted = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as Record<
      string,
      unknown
    >;
    assert.equal(persisted.pid, 10);
    assert.equal(persisted.cwd, "/repo");
    assert.equal(persisted.instanceId, "new-instance");
    assert.equal(typeof persisted.heartbeatMs, "number");
    assert.equal(persisted.leaderEpoch, "new-epoch");
    assert.deepEqual(events, ["start", "status"]);
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Default runtime generation supersedes a pre-reload same-process counter", () => {
  const temp = createTempLockPath();
  try {
    writeLocks(temp.path, {
      [TELEGRAM_LOCK_KEY]: {
        pid: 10,
        cwd: "/repo",
        instanceId: "10:old-reload",
        heartbeatMs: Date.now(),
        leaderEpoch: "old-epoch",
        runtimeGeneration: 2,
      },
    });
    const replacement = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "10:new-reload",
      mintLeaderEpoch: () => "new-epoch",
    });

    const expectedOwner = readLocks(temp.path)[
      TELEGRAM_LOCK_KEY
    ] as TelegramLockEntry;
    const acquired = replacement.acquire(
      { cwd: "/repo" },
      { force: true, expectedOwner },
    );

    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    assert.equal(acquired.lock.instanceId, "10:new-reload");
    assert.ok((acquired.lock.runtimeGeneration ?? 0) > 2);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Older same-process runtime cannot reverse a replacement handoff", async () => {
  const temp = createTempLockPath();
  try {
    const oldLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "old-instance",
      runtimeGeneration: 1,
      mintLeaderEpoch: () => "old-epoch",
    });
    const newLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "new-instance",
      runtimeGeneration: 2,
      mintLeaderEpoch: () => "new-epoch",
    });
    assert.equal(oldLock.acquire({ cwd: "/repo" }).ok, true);
    const newRuntime = createTelegramLockedPollingRuntime({
      lock: newLock,
      hasBotToken: () => true,
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });
    assert.equal((await newRuntime.start({ cwd: "/repo" })).ok, true);
    const oldRuntime = createTelegramLockedPollingRuntime({
      lock: oldLock,
      hasBotToken: () => true,
      startPolling: async () => assert.fail("Old runtime must not restart"),
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    assert.equal((await oldRuntime.start({ cwd: "/repo" })).ok, false);
    await oldRuntime.onSessionStart({}, { cwd: "/repo" });
    const persisted = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as Record<
      string,
      unknown
    >;
    assert.equal(persisted.pid, 10);
    assert.equal(persisted.cwd, "/repo");
    assert.equal(persisted.instanceId, "new-instance");
    assert.equal(typeof persisted.heartbeatMs, "number");
    assert.equal(persisted.leaderEpoch, "new-epoch");
    assert.equal(persisted.runtimeGeneration, 2);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Same instance id cannot bypass same-process generation handoff", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "10:1000",
      runtimeGeneration: 1,
      mintLeaderEpoch: () => "first-epoch",
    });
    const second = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "10:1000",
      runtimeGeneration: 2,
      mintLeaderEpoch: () => "second-epoch",
    });
    const acquiredFirst = first.acquire({ cwd: "/repo" });
    assert.equal(acquiredFirst.ok, true);
    assert.equal(second.owns({ cwd: "/repo" }), false);
    assert.equal(
      second.acquire(
        { cwd: "/repo" },
        {
          force: true,
          expectedOwner: acquiredFirst.ok ? acquiredFirst.lock : undefined,
        },
      ).ok,
      true,
    );
    assert.equal(first.owns({ cwd: "/repo" }), false);
    assert.equal(second.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Retained lock ownership cannot cross a dynamic profile key", () => {
  const temp = createTempLockPath();
  try {
    let activeProfileName: string | undefined;
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      key: () => resolveTelegramLockKey(activeProfileName),
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    const locks = readLocks(temp.path);
    locks.work = { pid: 10, cwd: "/repo" };
    writeLocks(temp.path, locks);

    activeProfileName = "work";
    assert.equal(lock.owns({ cwd: "/repo" }), false);
    assert.equal(lock.refresh({ cwd: "/repo" }), false);
    lock.release();
    assert.deepEqual(readLocks(temp.path), {
      default: { pid: 10, cwd: "/repo" },
      work: { pid: 10, cwd: "/repo" },
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime releases ownership when setup is missing", async () => {
  const temp = createTempLockPath();
  try {
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => false,
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });
    const started = await runtime.start({ cwd: "/repo" });
    assert.deepEqual(started, {
      ok: false,
      message: "Telegram bot is not configured.",
    });
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime reports an unresolved token reference", async () => {
  const temp = createTempLockPath();
  try {
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => false,
      getBotTokenDiagnostic: () =>
        "Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });
    const started = await runtime.start({ cwd: "/repo" });
    assert.deepEqual(started, {
      ok: false,
      message: "Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
    });
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime refuses start when run mode disallows polling", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      canStartPolling: (ctx: { cwd: string; mode?: string }) =>
        ctx.mode !== "print",
      formatStartBlockedMessage: (ctx) =>
        `Telegram polling is unavailable in Pi ${ctx.mode} mode.`,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    const started = await runtime.start({ cwd: "/repo", mode: "print" });
    assert.deepEqual(started, {
      ok: false,
      message: "Telegram polling is unavailable in Pi print mode.",
    });
    assert.deepEqual(events, []);
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime refreshes ownership during slow startup", async () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      getNowMs: () => nowMs,
      mintLeaderEpoch: () => "epoch",
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        await startGate;
      },
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
      ownershipCheckMs: 5,
      ownershipRefreshMs: 5,
    });

    const started = runtime.start({ cwd: "/repo" });
    nowMs = 2000;
    await waitForCondition(
      () =>
        (readLocks(temp.path)[TELEGRAM_LOCK_KEY] as { heartbeatMs?: number })
          ?.heartbeatMs === 2000,
      2_000,
    );
    releaseStart?.();
    assert.equal((await started).ok, true);
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime checks ownership more often than it refreshes the lease", () => {
  assert.ok(TELEGRAM_OWNERSHIP_CHECK_MS < TELEGRAM_OWNERSHIP_REFRESH_MS);
  assert.equal(
    TELEGRAM_OWNERSHIP_REFRESH_MS,
    TELEGRAM_OWNERSHIP_CHECK_MS * 2,
  );
});

test("Locked polling runtime fails startup closed after ownership loss", async () => {
  const temp = createTempLockPath();
  try {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const events: string[] = [];
    let pollingActive = false;
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
        await startGate;
        pollingActive = true;
      },
      stopPolling: async () => {
        events.push("stop");
        pollingActive = false;
      },
      updateStatus: () => undefined,
      ownershipCheckMs: 5,
    });

    const started = runtime.start({ cwd: "/repo" });
    await waitForCondition(() => events.includes("start"));
    writeLocks(temp.path, {
      [TELEGRAM_LOCK_KEY]: {
        pid: 99,
        cwd: "/other",
        instanceId: "replacement",
        leaderEpoch: "replacement-epoch",
      },
    });
    await waitForCondition(() => events.includes("stop"));
    releaseStart?.();
    const result = await started;
    assert.equal(result.ok, false);
    assert.equal(pollingActive, false);
    assert.deepEqual(events, ["start", "stop", "stop"]);
    assert.equal(
      (readLocks(temp.path)[TELEGRAM_LOCK_KEY] as { instanceId?: string })
        .instanceId,
      "replacement",
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime rolls back ownership when startup fails", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    let availabilityChanges = 0;
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        throw new Error("startup failed");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      onTransportAvailabilityChanged: () => {
        availabilityChanges += 1;
      },
      updateStatus: () => undefined,
    });

    await assert.rejects(runtime.start({ cwd: "/repo" }), /startup failed/);
    assert.deepEqual(readLocks(temp.path), {});
    assert.deepEqual(events, ["stop"]);
    assert.equal(availabilityChanges, 1);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime refreshes retained heartbeat before auto-start", async () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    const observedHeartbeats: Array<number | undefined> = [];
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      getNowMs: () => nowMs,
      mintLeaderEpoch: () => "epoch",
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    nowMs = 6000;
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        observedHeartbeats.push(
          (
            readLocks(temp.path)[TELEGRAM_LOCK_KEY] as {
              heartbeatMs?: number;
            }
          ).heartbeatMs,
        );
      },
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => observedHeartbeats.length === 1);
    assert.deepEqual(observedHeartbeats, [6000]);
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime auto-starts only from an existing owned lock", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["start", "status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
    assert.deepEqual(events, ["start", "status", "stop"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime auto-connects a remembered follower under a live leader", async () => {
  const temp = createTempLockPath();
  try {
    const owner = {
      pid: 20,
      cwd: "/leader",
      instanceId: "leader",
      heartbeatMs: Date.now(),
      leaderEpoch: "leader-epoch",
    };
    writeFileSync(temp.path, JSON.stringify({ [TELEGRAM_LOCK_KEY]: owner }));
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "follower",
      isProcessAlive: (pid) => pid === 20,
    });
    const events: string[] = [];
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("leader-start");
      },
      stopPolling: async () => undefined,
      restoreFollowerWithOwner: async (_ctx, observedOwner) => {
        assert.equal(observedOwner.pid, owner.pid);
        assert.equal(observedOwner.instanceId, owner.instanceId);
        assert.equal(observedOwner.leaderEpoch, owner.leaderEpoch);
        events.push("follower-restore");
        return true;
      },
      onTransportAvailabilityChanged: () => {
        events.push("availability");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["follower-restore", "availability", "status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], owner);
    await runtime.suspend();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime session auto-start does not block session initialization", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    let releaseStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start:begin");
        await started;
        events.push("start:end");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    assert.equal(events.length, 0);
    await waitForCondition(() => events.includes("start:begin"));
    assert.deepEqual(events, ["start:begin"]);
    releaseStart?.();
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["start:begin", "start:end", "status"]);
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime suspend waits for pending session auto-start before stopping", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    let releaseStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start:begin");
        await started;
        events.push("start:end");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("start:begin"));
    const suspend = runtime.suspend();
    releaseStart?.();
    await suspend;
    assert.deepEqual(events, ["start:begin", "start:end", "stop"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime does not auto-start when run mode disallows polling", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      canStartPolling: (ctx: { cwd: string; mode?: string }) =>
        ctx.mode !== "print",
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo", mode: "print" });
    assert.deepEqual(events, []);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime suspends session replacement without releasing ownership", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    assert.equal((await runtime.start({ cwd: "/repo" })).ok, true);
    await runtime.suspend();
    assert.deepEqual(events, ["start", "status", "stop"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Persistent conflicts stop watchers and monitoring, revoke sends, and release only exact ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const scenario of ["owned", "lost", "release-failure"] as const) {
    const temp = createTempLockPath();
    const ctx = { cwd: "/repo" };
    const lock = createTelegramLockRuntime({
      locksPath: temp.path, pid: 10, instanceId: "local", isProcessAlive: () => true,
    });
    let refreshes = 0;
    let checks = 0;
    const refresh = lock.refresh;
    const owns = lock.owns;
    lock.refresh = (owner) => { refreshes++; return refresh(owner); };
    lock.owns = (owner) => { checks++; return owns(owner); };
    let stops = 0;
    let monitoring = false;
    const availability: boolean[] = [];
    const diagnostics: Array<Record<string, unknown> | undefined> = [];
    const runtime = createTelegramLockedPollingRuntime({
      lock, hasBotToken: () => true, ownershipCheckMs: 1, ownershipRefreshMs: 2,
      startPolling: async () => {}, stopPolling: async () => { stops++; },
      transportMonitor: { start: () => { monitoring = true; }, stop: () => { monitoring = false; } },
      onTransportAvailabilityChanged: () => { availability.push(lock.owns(ctx)); },
      updateStatus: () => {},
      recordRuntimeEvent: (_category, _error, details) => { diagnostics.push(details); },
    });
    try {
      assert.equal((await runtime.start(ctx)).ok, true);
      t.mock.timers.tick(4);
      assert.ok(refreshes > 1);
      let replacement: unknown;
      if (scenario === "lost") {
        const other = createTelegramLockRuntime({
          locksPath: temp.path, pid: 20, instanceId: "other", isProcessAlive: () => true,
        });
        const expectedOwner = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as TelegramLockEntry;
        assert.equal(other.acquire(ctx, { force: true, expectedOwner }).ok, true);
        replacement = readLocks(temp.path)[TELEGRAM_LOCK_KEY];
      } else if (scenario === "release-failure") {
        writeFileSync(temp.path, "{");
      }
      await runtime.onPersistentConflict(ctx, 10);
      const stoppedCounts = [checks, refreshes];
      t.mock.timers.tick(100);
      await runtime.onPersistentConflict(ctx, 10);
      assert.deepEqual([checks, refreshes], stoppedCounts, "Watchers must stay stopped");
      assert.equal(stops, 1);
      assert.equal(monitoring, false);
      assert.deepEqual(availability, [true, false]);
      assert.equal(lock.owns(ctx), false);
      assert.equal(lock.getOwnedLeaderEpoch(), undefined);
      assert.equal(lock.commitIfOwned(() => assert.fail("Revoked direct effect")), false);
      assert.equal(lock.refresh(ctx), false);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.phase, "persistent-conflict");
      assert.equal(diagnostics[0]?.ownership, scenario === "release-failure" ? "unverifiable" : scenario);
      if (scenario === "release-failure") {
        assert.equal(readFileSync(temp.path, "utf8"), "{");
        assert.ok(Array.isArray(diagnostics[0]?.cleanupErrors));
      } else {
        assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], replacement);
      }
    } finally {
      await runtime.suspend();
      rmSync(temp.dir, { recursive: true, force: true });
    }
  }
});

test("A failed durable release stays locally revoked until explicit acquisition mints a new epoch", () => {
  const temp = createTempLockPath();
  const ctx = { cwd: "/repo" };
  const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10, instanceId: "local" });
  try {
    lock.acquire(ctx);
    const epoch = lock.getOwnedLeaderEpoch();
    const original = readFileSync(temp.path, "utf8");
    writeFileSync(temp.path, "{");
    assert.throws(() => lock.release());
    writeFileSync(temp.path, original);
    assert.equal(lock.owns(ctx), false, "Repair must not resurrect revoked authority");
    assert.equal(lock.commitIfOwned(() => assert.fail("Revoked publication")), false);
    assert.equal(lock.refresh(ctx), false);
    assert.equal(lock.acquire(ctx).ok, true);
    assert.equal(lock.owns(ctx), true);
    assert.notEqual(lock.getOwnedLeaderEpoch(), epoch);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Conflict fencing accepts same-session context rotation but rejects a replaced session", async () => {
  const temp = createTempLockPath();
  const pollContext = { cwd: "/repo", generation: 1 };
  let generation = 1;
  let stops = 0;
  const lock = createTelegramLockRuntime<typeof pollContext>({ locksPath: temp.path, pid: 10 });
  const runtime = createTelegramLockedPollingRuntime({
    lock, hasBotToken: () => true,
    isContextCurrent: (ctx) => ctx.generation === generation,
    startPolling: async () => {}, stopPolling: async () => { stops++; }, updateStatus: () => {},
  });
  try {
    await runtime.start(pollContext);
    await runtime.start({ ...pollContext });
    await runtime.onPersistentConflict(pollContext, 10);
    assert.equal(stops, 1, "An existing poller may retain the preceding command context");
    assert.equal(lock.owns(pollContext), false);
    generation++;
    const replacement = { cwd: "/repo", generation };
    await runtime.start(replacement);
    await runtime.onPersistentConflict(pollContext, 10);
    assert.equal(stops, 1);
    assert.equal(lock.owns(replacement), true);
  } finally {
    await runtime.stop();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("A later suspend, disconnect, or session replacement cancels a reconnect waiting for conflict teardown", async () => {
  for (const cancellation of ["suspend", "disconnect", "replacement"] as const) {
    const temp = createTempLockPath();
    const ctx = { cwd: "/repo" };
    let current = ctx;
    let finishStop!: () => void;
    const gate = new Promise<void>((resolve) => { finishStop = resolve; });
    let polling = false;
    let monitoring = false;
    let acquisitions = 0;
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const acquire = lock.acquire;
    lock.acquire = (...args) => { acquisitions++; return acquire(...args); };
    const runtime = createTelegramLockedPollingRuntime({
      lock, hasBotToken: () => true, isContextCurrent: (context) => context === current,
      startPolling: async (context) => { if (context === current) polling = true; },
      stopPolling: async () => { await gate; polling = false; },
      transportMonitor: {
        start: () => { monitoring = true; }, stop: () => { monitoring = false; },
      },
      updateStatus: () => {},
    });
    try {
      assert.equal((await runtime.start(ctx)).ok, true);
      polling = false; // The controller detaches before notifying the locked lifecycle.
      const conflict = runtime.onPersistentConflict(ctx, 10);
      const reconnect = runtime.start(ctx);
      const halted = cancellation === "disconnect" ? runtime.stop() : runtime.suspend();
      if (cancellation === "replacement") current = { cwd: "/repo" };
      finishStop();
      await Promise.all([conflict, halted]);
      assert.equal((await reconnect).ok, false, cancellation);
      assert.equal(acquisitions, 1, "Cancelled reconnect must never reacquire the lock");
      assert.equal(polling, false);
      assert.equal(monitoring, false);
      assert.equal(lock.owns(current), false);
      assert.equal((await runtime.start(current)).ok, true, "A fresh explicit connect remains valid");
      assert.equal(polling, true);
    } finally {
      finishStop();
      await runtime.stop();
      rmSync(temp.dir, { recursive: true, force: true });
    }
  }
});

test("Cancelled startup continuations cannot start transport or tear down a replacement", async () => {
  for (const boundary of ["acquired", "polling"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      const temp = createTempLockPath();
      const old = { cwd: "/repo" };
      const replacement = { cwd: "/repo" };
      let finish!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const pause = async () => {
        entered();
        await gate;
        if (outcome === "reject") throw new Error("Obsolete startup failed");
      };
      const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
      const starts: typeof old[] = [];
      let stops = 0;
      const runtime = createTelegramLockedPollingRuntime({
        lock, hasBotToken: () => true,
        startPolling: async (ctx) => {
          starts.push(ctx);
          if (ctx === old && boundary === "polling") await pause();
        },
        stopPolling: async () => { stops++; }, updateStatus: () => {},
      });
      try {
        const staleStart = runtime.start(old, boundary === "acquired" ? { onAcquired: pause } : {});
        await started;
        await runtime.suspend();
        assert.equal((await runtime.start(replacement)).ok, true);
        finish();
        assert.equal((await staleStart).ok, false);
        assert.deepEqual(starts, boundary === "acquired" ? [replacement] : [old, replacement]);
        assert.equal(stops, 1, "A stale rejection must not roll back the replacement");
        assert.equal(lock.owns(replacement), true);
      } finally {
        finish();
        await runtime.stop();
        rmSync(temp.dir, { recursive: true, force: true });
      }
    }
  }
});

test("Conflict teardown serializes reconnect and ignores an obsolete session signal", async () => {
  const temp = createTempLockPath();
  const oldContext = { cwd: "/repo" };
  const newContext = { cwd: "/repo" };
  const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
  let finishStop!: () => void;
  let stops = 0;
  const pending = new Promise<void>((resolve) => { finishStop = resolve; });
  const runtime = createTelegramLockedPollingRuntime({
    lock, hasBotToken: () => true, startPolling: async () => {},
    stopPolling: async () => { stops++; await pending; }, updateStatus: () => {},
  });
  try {
    await runtime.start(oldContext);
    const stopped = runtime.onPersistentConflict(oldContext, 10);
    const restarted = runtime.start(newContext);
    assert.equal(lock.owns(oldContext), false);
    finishStop();
    await stopped;
    assert.equal((await restarted).ok, true);
    await runtime.onPersistentConflict(oldContext, 10);
    assert.equal(stops, 1);
    assert.equal(lock.owns(newContext), true);
  } finally {
    finishStop();
    await runtime.stop();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime stops after ownership loss without live context", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const runtimeEvents: {
      category: string;
      phase: unknown;
      message: string;
    }[] = [];
    let availabilityChanges = 0;
    const ctx = { cwd: "/repo" };
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      ownershipCheckMs: 1,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
      onTransportAvailabilityChanged: () => {
        availabilityChanges += 1;
      },
      recordRuntimeEvent: (category, error, details) => {
        runtimeEvents.push({
          category,
          phase: details?.phase,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    assert.equal((await runtime.start(ctx)).ok, true);
    writeFileSync(temp.path, JSON.stringify({}));
    await waitForCondition(() => events.includes("stop"));
    assert.deepEqual(events, ["start", "status", "stop"]);
    assert.equal(availabilityChanges, 2);
    assert.deepEqual(runtimeEvents, []);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime records refresh write failures instead of throwing from watcher", async () => {
  const events: string[] = [];
  const runtimeEvents: {
    category: string;
    phase: unknown;
    message: string;
  }[] = [];
  let refreshCalls = 0;
  const lock = {
    acquire: () => ({
      ok: true,
      lock: { pid: 10, cwd: "/repo" },
      replacedStale: false as const,
    }),
    release: () => ({ kind: "inactive" as const }),
    getState: () => ({
      kind: "active-here" as const,
      lock: { pid: 10, cwd: "/repo" },
    }),
    getStatusLabel: () => "active here",
    getOwnedLeaderEpoch: () => undefined,
    owns: () => true,
    commitIfOwned: (commit: () => void) => {
      commit();
      return true;
    },
    refresh: () => {
      refreshCalls += 1;
      if (refreshCalls === 1) return true;
      throw new Error("EPERM: operation not permitted, rename locks tmp");
    },
  };
  const runtime = createTelegramLockedPollingRuntime({
    lock,
    hasBotToken: () => true,
    ownershipCheckMs: 1,
    ownershipRefreshMs: 1,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push({
        category,
        phase: details?.phase,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  assert.equal((await runtime.start({ cwd: "/repo" })).ok, true);
  await waitForCondition(() => events.includes("stop"));
  assert.deepEqual(events, ["start", "status", "stop"]);
  assert.equal(runtimeEvents[0]?.category, "lock");
  assert.equal(runtimeEvents[0]?.phase, "refresh");
  assert.match(runtimeEvents[0]?.message ?? "", /EPERM/);
});

test("Locked polling runtime resumes stale same-cwd ownership after process restart", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: () => false,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["start", "status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime does not claim stale ownership from another cwd during session initialization", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/other" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: () => false,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo" });
    assert.deepEqual(events, []);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 99,
      cwd: "/other",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});
