/**
 * Regression tests for Telegram singleton lock helpers
 * Covers locks.json ownership, stale-lock replacement, and locked polling auto-start behavior
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramLockedPollingRuntime,
  createTelegramLockKeyResolver,
  createTelegramLockRuntime,
  readLocks,
  resolveTelegramLockKey,
  TELEGRAM_LOCK_KEY,
  writeLocks,
  type TelegramLockEntry,
} from "../lib/locks.ts";

function createTempLockPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-locks-"));
  return { dir, path: join(dir, "locks.json") };
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
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        LOCKS_PATH: input.locksPath,
        LOCK_KEY: input.key,
        READY_PATH: input.readyPath,
        START_PATH: input.startPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = new Promise<{ ok: boolean; pid?: number }>(
    (resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Lock race child exited ${code}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as { ok: boolean; pid?: number });
      });
    },
  );
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

test("Lock key resolver preserves default compatibility and scopes named profiles", () => {
  let activeProfileName: string | undefined;
  const resolveKey = createTelegramLockKeyResolver({
    getActiveProfileName: () => activeProfileName,
  });

  assert.equal(resolveTelegramLockKey(), TELEGRAM_LOCK_KEY);
  assert.equal(resolveKey(), TELEGRAM_LOCK_KEY);
  activeProfileName = "omp";
  assert.equal(resolveKey(), `${TELEGRAM_LOCK_KEY}:omp`);
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
    assert.deepEqual(readLocks(temp.path)[`${TELEGRAM_LOCK_KEY}:work`], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(readLocks(temp.path)[`${TELEGRAM_LOCK_KEY}:omp`], undefined);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("writeLocks writes private lock files", () => {
  const temp = createTempLockPath();
  try {
    writeLocks(temp.path, { [TELEGRAM_LOCK_KEY]: { pid: 10 } });
    assert.equal(statSync(temp.path).mode & 0o777, 0o600);
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
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.throws(
      () => lock.acquire({ cwd: "/repo" }),
      /Timed out acquiring Telegram lock transaction/,
    );
    assert.equal(readFileSync(`${temp.path}.transaction`, "utf8"), "");
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
    const persisted = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as { pid: number };
    assert.equal(
      persisted.pid,
      results.find((result) => result.ok)?.pid,
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Concurrent stale-guard recovery elects exactly one child process", async () => {
  const temp = createTempLockPath();
  const startPath = join(temp.dir, "start");
  const readyPaths = [join(temp.dir, "ready-a"), join(temp.dir, "ready-b")];
  try {
    writeFileSync(
      `${temp.path}.transaction`,
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-race-guard",
      }),
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
  const keys = [TELEGRAM_LOCK_KEY, `${TELEGRAM_LOCK_KEY}:work`];
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
    assert.equal(results.every((result) => result.ok), true);
    const persisted = readLocks(temp.path);
    assert.deepEqual(Object.keys(persisted).sort(), [...keys].sort());
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime preserves other extension keys and refuses live polling owners", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify(
        {
          "other-extension": { pid: 123 },
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
    assert.deepEqual(readLocks(temp.path)["other-extension"], { pid: 123 });
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
        expectedOwner:
          observed.kind === "stale" ? observed.lock : undefined,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(leader.owns({ cwd: "/repo" }), true);
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
    assert.equal(typeof (firstResult.ok && firstResult.lock.leaderEpoch), "string");
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
    writeLocks(
      temp.path,
      {
        [TELEGRAM_LOCK_KEY]: {
          pid: 10,
          cwd: "/repo",
          instanceId: "10:old-reload",
          heartbeatMs: Date.now(),
          leaderEpoch: "old-epoch",
          runtimeGeneration: 2,
        },
      },
    );
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
    locks[`${TELEGRAM_LOCK_KEY}:work`] = { pid: 10, cwd: "/repo" };
    writeLocks(temp.path, locks);

    activeProfileName = "work";
    assert.equal(lock.owns({ cwd: "/repo" }), false);
    assert.equal(lock.refresh({ cwd: "/repo" }), false);
    lock.release();
    assert.deepEqual(readLocks(temp.path), {
      [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" },
      [`${TELEGRAM_LOCK_KEY}:work`]: { pid: 10, cwd: "/repo" },
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
    });

    const started = runtime.start({ cwd: "/repo" });
    nowMs = 2000;
    await waitForCondition(
      () =>
        (readLocks(temp.path)[TELEGRAM_LOCK_KEY] as { heartbeatMs?: number })
          ?.heartbeatMs === 2000,
    );
    releaseStart?.();
    assert.equal((await started).ok, true);
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
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
      updateStatus: () => undefined,
    });

    await assert.rejects(runtime.start({ cwd: "/repo" }), /startup failed/);
    assert.deepEqual(readLocks(temp.path), {});
    assert.deepEqual(events, ["stop"]);
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

test("Locked polling runtime stops after ownership loss without live context", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const runtimeEvents: {
      category: string;
      phase: unknown;
      message: string;
    }[] = [];
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
    acquire: () => ({ ok: true, lock: { pid: 10, cwd: "/repo" }, replacedStale: false as const }),
    release: () => ({ kind: "inactive" as const }),
    getState: () => ({ kind: "active-here" as const, lock: { pid: 10, cwd: "/repo" } }),
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
