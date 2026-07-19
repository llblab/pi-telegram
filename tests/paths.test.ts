/**
 * Regression tests for Telegram bridge path resolution
 * Guards agent-dir detection for Pi-compatible runtimes and path derivation helpers.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  getTelegramDiagnosticsDisplayPaths,
  getTelegramProfilePathSuffix,
  resolveAgentDir,
  resolveTelegramConfigPath,
  resolveTelegramOwnersPath,
  resolveTelegramProfileTempFilePath,
  resolveTelegramRuntimeLogPath,
  resolveTelegramTempDir,
} from "../lib/paths.ts";

await test("resolveAgentDir", async (t) => {
  await t.test("returns PI_CODING_AGENT_DIR when env is set", () => {
    assert.equal(
      resolveAgentDir({
        env: { PI_CODING_AGENT_DIR: "/custom/agent/dir" },
        execPath: "/usr/bin/omp",
        argv: ["omp"],
      }),
      resolve("/custom/agent/dir"),
    );
  });

  await t.test("returns ~/.omp/agent for OMP-compatible runtimes", () => {
    assert.equal(
      resolveAgentDir({ env: {}, execPath: "/home/user/.local/bin/omp" }),
      join(homedir(), ".omp", "agent"),
    );
    assert.equal(
      resolveAgentDir({
        env: {},
        execPath: "/usr/bin/node",
        argv: ["node", "omp"],
      }),
      join(homedir(), ".omp", "agent"),
    );
  });

  await t.test(
    "returns ~/.pi/agent as fallback when no env and no OMP runtime",
    () => {
      assert.equal(
        resolveAgentDir({ env: {}, execPath: "/usr/bin/node", argv: ["node"] }),
        join(homedir(), ".pi", "agent"),
      );
    },
  );
});

await test("resolveTelegramConfigPath", () => {
  assert.ok(
    resolveTelegramConfigPath().endsWith("telegram.json"),
    "config path ends with telegram.json",
  );
});

await test("resolveTelegramOwnersPath", () => {
  assert.ok(
    resolveTelegramOwnersPath().endsWith(join("tmp", "telegram", "owners.json")),
    "owners path ends with the platform-native tmp/telegram/owners.json suffix",
  );
});

await test("resolveTelegramTempDir", () => {
  assert.ok(
    resolveTelegramTempDir().endsWith(join("tmp", "telegram")),
    "temp dir ends with the platform-native tmp/telegram suffix",
  );
});

await test("resolveTelegramRuntimeLogPath", () => {
  assert.ok(
    resolveTelegramRuntimeLogPath().endsWith(
      join("tmp", "telegram", "logs.jsonl"),
    ),
    "runtime log path ends with the platform-native logs.jsonl suffix",
  );
});

await test("explicit default profile keeps canonical unsuffixed paths", () => {
  assert.equal(getTelegramProfilePathSuffix("default"), "");
  assert.equal(
    resolveTelegramProfileTempFilePath("state", "json", "/agent", "default"),
    resolveTelegramProfileTempFilePath("state", "json", "/agent"),
  );
  assert.deepEqual(
    getTelegramDiagnosticsDisplayPaths("default"),
    getTelegramDiagnosticsDisplayPaths(),
  );
});
