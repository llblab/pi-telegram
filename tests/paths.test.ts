/**
 * Regression tests for Telegram bridge path resolution
 * Guards agent-dir detection for Pi-compatible runtimes and path derivation helpers.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  resolveAgentDir,
  resolveTelegramConfigPath,
  resolveTelegramLocksPath,
  resolveTelegramTempDir,
  resolveTelegramBusSocketPath,
  resolveTelegramRuntimeLogPath,
} from "../lib/paths.ts";

await test("resolveAgentDir", async (t) => {
  await t.test("returns PI_CODING_AGENT_DIR when env is set", () => {
    const saved = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = "/custom/agent/dir";
      assert.equal(resolveAgentDir(), resolve("/custom/agent/dir"));
    } finally {
      if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved;
      else delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  await t.test("returns ~/.pi/agent as fallback when no env and no OMP runtime", () => {
    // Save and unset
    const saved = process.env.PI_CODING_AGENT_DIR;
    const savedExecPath = process.execPath;
    const savedArgv1 = process.argv[1];
    try {
      delete process.env.PI_CODING_AGENT_DIR;
      if (process.execPath) {
        // Simulate standard Pi: executable doesn't start with "omp"
        // and argv[1] doesn't start with "omp"
        // (the real test runner is "node", which is not "omp")
      }
      const result = resolveAgentDir();
      assert.equal(result, join(homedir(), ".pi", "agent"));
    } finally {
      if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved;
    }
  });
});

await test("resolveTelegramConfigPath", () => {
  assert.ok(
    resolveTelegramConfigPath().endsWith("telegram.json"),
    "config path ends with telegram.json",
  );
});

await test("resolveTelegramLocksPath", () => {
  assert.ok(
    resolveTelegramLocksPath().endsWith("locks.json"),
    "locks path ends with locks.json",
  );
});

await test("resolveTelegramTempDir", () => {
  assert.ok(
    resolveTelegramTempDir().endsWith("/tmp/telegram"),
    "temp dir ends with /tmp/telegram",
  );
});

await test("resolveTelegramBusSocketPath", () => {
  assert.ok(
    resolveTelegramBusSocketPath().endsWith("/tmp/telegram/bus.sock"),
    "bus socket path ends with bus.sock",
  );
});

await test("resolveTelegramRuntimeLogPath", () => {
  assert.ok(
    resolveTelegramRuntimeLogPath().endsWith("/tmp/telegram/logs.jsonl"),
    "runtime log path ends with logs.jsonl",
  );
});
