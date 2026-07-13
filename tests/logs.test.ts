/**
 * Regression tests for Telegram runtime JSONL diagnostics log
 * Covers session-local reset, scope changes, and append-only event evidence
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramRuntimeJsonlLog,
  getTelegramPreviousRuntimeLogPath,
  getTelegramRuntimeLogPath,
} from "../lib/logs.ts";

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

test("Runtime log paths preserve default compatibility and isolate named profiles", async () => {
  assert.equal(
    getTelegramRuntimeLogPath("/agent"),
    "/agent/tmp/telegram/logs.jsonl",
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent"),
    "/agent/tmp/telegram/logs._prev.jsonl",
  );
  assert.equal(
    getTelegramRuntimeLogPath("/agent", "omp"),
    "/agent/tmp/telegram/logs.omp.jsonl",
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent", "omp"),
    "/agent/tmp/telegram/logs.omp._prev.jsonl",
  );
});

test("Runtime JSONL paths do not collide across profile lifecycle names", () => {
  const profiles = [
    "prev",
    "previous",
    "current",
    "work",
    "workone",
    "worktwo",
  ];
  const paths = new Set([
    getTelegramRuntimeLogPath("/agent"),
    getTelegramPreviousRuntimeLogPath("/agent"),
  ]);
  for (const profile of profiles) {
    paths.add(getTelegramRuntimeLogPath("/agent", profile));
    paths.add(getTelegramPreviousRuntimeLogPath("/agent", profile));
  }
  assert.equal(paths.size, 2 + profiles.length * 2);
  assert.equal(
    getTelegramRuntimeLogPath("/agent", "previous"),
    "/agent/tmp/telegram/logs.previous.jsonl",
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent", "previous"),
    "/agent/tmp/telegram/logs.previous._prev.jsonl",
  );
});

test("Runtime JSONL log resets and appends session events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-"));
  try {
    let nowMs = 1000;
    const path = join(dir, "logs.jsonl");
    const previousPath = join(dir, "logs._prev.jsonl");
    const log = createTelegramRuntimeJsonlLog({
      path,
      previousPath,
      getNowMs: () => nowMs,
    });

    log.reset("extension-start", { role: "leader" });
    log.record({
      at: 1001,
      category: "bus",
      message: "started",
      details: { phase: "leader-start" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(await readJsonl(path), [
      {
        at: 1000,
        kind: "reset",
        reason: "extension-start",
        scope: { role: "leader" },
        previousPath,
      },
      {
        at: 1001,
        kind: "event",
        category: "bus",
        message: "started",
        details: { phase: "leader-start" },
      },
    ]);

    nowMs = 2000;
    log.resetIfScopeChanged("follower", "status-scope-change", {
      role: "follower",
    });
    assert.deepEqual(await readJsonl(path), [
      {
        at: 2000,
        kind: "reset",
        reason: "status-scope-change",
        scope: { role: "follower" },
        previousPath,
      },
    ]);
    assert.deepEqual(await readJsonl(previousPath), [
      {
        at: 1000,
        kind: "reset",
        reason: "extension-start",
        scope: { role: "leader" },
        previousPath,
      },
      {
        at: 1001,
        kind: "event",
        category: "bus",
        message: "started",
        details: { phase: "leader-start" },
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL destructive reset commits only under exact ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-reset-fence-"));
  const path = join(dir, "logs.jsonl");
  let owned = false;
  try {
    await writeFile(path, '{"kind":"event","message":"replacement"}\n');
    const log = createTelegramRuntimeJsonlLog({
      path,
      canReset: () => true,
      commitReset(commit) {
        if (!owned) return false;
        commit();
        return true;
      },
    });

    log.resetIfScopeChanged("leader", "status-scope-change", {
      role: "leader",
    });
    assert.deepEqual(await readJsonl(path), [
      { kind: "event", message: "replacement" },
    ]);

    owned = true;
    log.resetIfScopeChanged("leader", "status-scope-change", {
      role: "leader",
    });
    assert.equal(
      ((await readJsonl(path))[0] as { kind?: string } | undefined)?.kind,
      "reset",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL appends serialize across processes without lost lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-race-"));
  const path = join(dir, "logs.jsonl");
  const startPath = join(dir, "start");
  const moduleUrl = new URL("../lib/logs.ts", import.meta.url).href;
  const children = ["a", "b"].map((worker) => {
    const readyPath = join(dir, `ready-${worker}`);
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createTelegramRuntimeJsonlLog } from ${JSON.stringify(moduleUrl)};
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const log = createTelegramRuntimeJsonlLog({ path: process.env.LOG_PATH, canReset: () => false });
      writeFileSync(process.env.READY_PATH, "ready");
      while (!existsSync(process.env.START_PATH)) sleep(2);
      for (let index = 0; index < 25; index += 1) {
        log.record({ at: index, category: process.env.WORKER, message: String(index) });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    `;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        env: {
          ...process.env,
          LOG_PATH: path,
          READY_PATH: readyPath,
          START_PATH: startPath,
          WORKER: worker,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const done = new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`log child exited ${code}: ${stderr}`)),
      );
    });
    return { readyPath, done };
  });
  try {
    const deadline = Date.now() + 3000;
    while (
      !children.every((child) => existsSync(child.readyPath)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(children.every((child) => existsSync(child.readyPath)), true);
    await writeFile(startPath, "start");
    await Promise.all(children.map((child) => child.done));
    const lines = await readJsonl(path);
    assert.equal(lines.length, 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL append captures its profile path before queued execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-path-capture-"));
  try {
    let profileName = "alpha";
    const log = createTelegramRuntimeJsonlLog({
      path: () => getTelegramRuntimeLogPath(dir, profileName),
      previousPath: () => getTelegramPreviousRuntimeLogPath(dir, profileName),
    });

    log.record({ at: 1000, category: "queue", message: "alpha event" });
    profileName = "beta";
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      await readJsonl(getTelegramRuntimeLogPath(dir, "alpha")),
      [{ at: 1000, kind: "event", category: "queue", message: "alpha event" }],
    );
    await assert.rejects(() => readJsonl(getTelegramRuntimeLogPath(dir, "beta")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL log keeps previous logs per active profile path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-profile-log-"));
  try {
    let profileName: string | undefined;
    let nowMs = 1000;
    const log = createTelegramRuntimeJsonlLog({
      path: () => getTelegramRuntimeLogPath(dir, profileName),
      previousPath: () => getTelegramPreviousRuntimeLogPath(dir, profileName),
      getNowMs: () => nowMs,
    });

    log.reset("default-start", { profile: "default" });
    profileName = "omp";
    nowMs = 2000;
    log.reset("profile-start", { profile: "omp" });
    log.record({ at: 2001, category: "bus", message: "profile event" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(await readJsonl(getTelegramRuntimeLogPath(dir)), [
      {
        at: 1000,
        kind: "reset",
        reason: "default-start",
        scope: { profile: "default" },
        previousPath: getTelegramPreviousRuntimeLogPath(dir),
      },
    ]);
    assert.deepEqual(await readJsonl(getTelegramRuntimeLogPath(dir, "omp")), [
      {
        at: 2000,
        kind: "reset",
        reason: "profile-start",
        scope: { profile: "omp" },
        previousPath: getTelegramPreviousRuntimeLogPath(dir, "omp"),
      },
      { at: 2001, kind: "event", category: "bus", message: "profile event" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
