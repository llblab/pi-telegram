/**
 * Regression tests for Telegram runtime JSONL diagnostics log
 * Covers session-local reset, scope changes, and append-only event evidence
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNodeEval } from "./fixtures/node-eval.ts";
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
    join("/agent", "tmp", "telegram", "logs.jsonl"),
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent"),
    join("/agent", "tmp", "telegram", "logs._prev.jsonl"),
  );
  assert.equal(
    getTelegramRuntimeLogPath("/agent", "omp"),
    join("/agent", "tmp", "telegram", "logs.omp.jsonl"),
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent", "omp"),
    join("/agent", "tmp", "telegram", "logs.omp._prev.jsonl"),
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
    join("/agent", "tmp", "telegram", "logs.previous.jsonl"),
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent", "previous"),
    join("/agent", "tmp", "telegram", "logs.previous._prev.jsonl"),
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

test("Runtime JSONL batching rotates between records that cross maxBytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-batch-rotate-"));
  const path = join(dir, "logs.jsonl");
  const previousPath = join(dir, "logs._prev.jsonl");
  try {
    const seedLine = `${JSON.stringify({ kind: "event", message: "seed" })}\n`;
    const firstLine = `${JSON.stringify({
      kind: "event",
      at: 1,
      category: "batch",
      message: "first",
    })}\n`;
    await writeFile(path, seedLine);
    const log = createTelegramRuntimeJsonlLog({
      path,
      previousPath,
      maxBytes: Buffer.byteLength(seedLine) + Buffer.byteLength(firstLine),
    });

    log.record({ at: 1, category: "batch", message: "first" });
    log.record({ at: 2, category: "batch", message: "second" });
    const deadline = Date.now() + 1000;
    while (!existsSync(previousPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(
      (await readJsonl(previousPath)).map(
        (entry) => (entry as { message?: string }).message,
      ),
      ["seed", "first"],
    );
    const current = await readJsonl(path);
    assert.equal((current[0] as { reason?: string }).reason, "max-bytes");
    assert.equal((current[1] as { message?: string }).message, "second");
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

test("Runtime JSONL append failures stay contained and do not poison later records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-failure-"));
  const blockerPath = join(dir, "not-a-directory");
  const validPath = join(dir, "logs.jsonl");
  let path = join(blockerPath, "logs.jsonl");
  try {
    await writeFile(blockerPath, "block mkdir");
    const log = createTelegramRuntimeJsonlLog({ path: () => path });
    log.record({ at: 1, category: "failure", message: "contained" });
    path = validPath;
    log.record({ at: 2, category: "recovery", message: "persisted" });

    const deadline = Date.now() + 1_000;
    while (!existsSync(validPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(await readJsonl(validPath), [
      {
        at: 2,
        kind: "event",
        category: "recovery",
        message: "persisted",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL contains one failed record under strict unhandled rejection mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-strict-failure-"));
  const blockerPath = join(dir, "not-a-directory");
  const moduleUrl = new URL("../lib/logs.ts", import.meta.url).href;
  try {
    await writeFile(blockerPath, "block mkdir");
    const source = `
      import { createTelegramRuntimeJsonlLog } from ${JSON.stringify(moduleUrl)};
      const log = createTelegramRuntimeJsonlLog({ path: process.env.LOG_PATH });
      log.record({ at: 1, category: "failure", message: "contained" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    `;
    const result = await runNodeEval(source, {
      env: { LOG_PATH: join(blockerPath, "logs.jsonl") },
      nodeArgs: ["--unhandled-rejections=strict"],
    });
    assert.equal(result.code, 0, result.stderr);
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
    const done = runNodeEval(source, {
      env: {
        LOG_PATH: path,
        READY_PATH: readyPath,
        START_PATH: startPath,
        WORKER: worker,
      },
    }).then(({ code, stderr }) => {
      if (code !== 0) throw new Error(`log child exited ${code}: ${stderr}`);
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
    const lines = (await readJsonl(path)) as {
      category?: string;
      message?: string;
    }[];
    assert.equal(lines.length, 50);
    for (const worker of ["a", "b"]) {
      assert.deepEqual(
        lines
          .filter((line) => line.category === worker)
          .map((line) => line.message),
        Array.from({ length: 25 }, (_, index) => String(index)),
      );
    }
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
