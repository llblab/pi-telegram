/**
 * Regression tests for Telegram runtime JSONL diagnostics log
 * Covers session-local reset, scope changes, and append-only event evidence
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    "/agent/tmp/telegram/logs.previous.jsonl",
  );
  assert.equal(
    getTelegramRuntimeLogPath("/agent", "omp"),
    "/agent/tmp/telegram/logs.omp.jsonl",
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent", "omp"),
    "/agent/tmp/telegram/logs.omp.previous.jsonl",
  );
});

test("Runtime JSONL log resets and appends session events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-"));
  try {
    let nowMs = 1000;
    const path = join(dir, "logs.jsonl");
    const previousPath = join(dir, "logs.previous.jsonl");
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
