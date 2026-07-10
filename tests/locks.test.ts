/**
 * Regression tests for Telegram singleton lock helpers
 * Covers locks.json ownership, stale-lock replacement, and locked polling auto-start behavior
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      heartbeatMs: 1000,
      leaderEpoch: 1000,
    });
    nowMs = 1500;
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      heartbeatMs: 1500,
      leaderEpoch: 1000,
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
          busSocketPath: join(temp.dir, "bus.sock"),
        },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => 1500,
    });
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      heartbeatMs: 1500,
      leaderEpoch: 1000,
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
  const lock = {
    acquire: () => ({ ok: true, lock: { pid: 10, cwd: "/repo" }, replacedStale: false as const }),
    release: () => ({ kind: "inactive" as const }),
    getState: () => ({ kind: "active-here" as const, lock: { pid: 10, cwd: "/repo" } }),
    getStatusLabel: () => "active here",
    owns: () => true,
    refresh: () => {
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
