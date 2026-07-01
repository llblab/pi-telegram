/**
 * Regression tests for Telegram runtime JSONL diagnostics log
 * Covers session-local reset, scope changes, and append-only event evidence
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTelegramRuntimeJsonlLog } from "../lib/runtime-log.ts";

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

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
