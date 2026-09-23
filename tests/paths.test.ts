/**
 * Regression tests for Telegram bridge path resolution
 * Guards agent-dir detection for Pi-compatible runtimes and path derivation helpers.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import {
  requireTelegramStoragePathReference,
  getTelegramDiagnosticsDisplayPaths,
  getTelegramProfilePathSuffix,
  resolveAgentDir,
  resolveTelegramConfigPath,
  resolveTelegramFollowerJournalPath,
  resolveTelegramOwnersPath,
  resolveTelegramProfileTempFilePath,
  resolveTelegramRuntimeLogPath,
  resolveTelegramTempDir,
  resolveTelegramChannelPostJournalPath,
  resolveTelegramThreadCleanupWorkPath,
  resolveTelegramUpdateJournalPath,
  resolveTelegramUpdateJournalPathForProfile,
  resolveTelegramWorkspaceAdmissionPath,
  resolveTelegramWorkspaceAdmissionPathForProfile,
} from "../lib/paths.ts";

test("Storage path reference admission requires exact absolute spelling without repairing aliases", () => {
  const agentDir = resolve("fixture-agent");
  const expected = resolveTelegramUpdateJournalPath(agentDir, "work");
  assert.equal(requireTelegramStoragePathReference(expected, expected), expected);
  const relative = join("work", "tmp", "telegram", "inbox.json");
  const alias = `${agentDir}${sep}unused${sep}..${sep}tmp${sep}telegram${sep}inbox.work.json`;
  for (const [actual, approved] of [
    [relative, expected], [relative, relative], [expected, relative],
    [alias, expected], [expected, alias], [alias, alias],
    [resolveTelegramUpdateJournalPath(agentDir), expected],
    [resolveTelegramUpdateJournalPath(agentDir, "other"), expected],
    [join(agentDir, "tmp", "telegram", "workspace-admission.work.json"), expected],
    [expected, ""], [undefined, expected], [expected, null],
  ]) {
    assert.throws(() => requireTelegramStoragePathReference(actual as string, approved as string),
      { message: "Telegram storage reference does not match its approved absolute path." });
  }
});

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

await test("thread cleanup work paths are profile-scoped", () => {
  assert.equal(resolveTelegramThreadCleanupWorkPath("/agent", "default"),
    join("/agent", "tmp", "telegram", "thread-cleanup.json"));
  assert.equal(resolveTelegramThreadCleanupWorkPath("/agent", "work"),
    join("/agent", "tmp", "telegram", "thread-cleanup.work.json"));
});

test("channel post journal paths are profile-scoped", () => {
  assert.equal(resolveTelegramChannelPostJournalPath("/agent", "default"),
    join("/agent", "tmp", "telegram", "channel-posts.json"));
  assert.equal(resolveTelegramChannelPostJournalPath("/agent", "work"),
    join("/agent", "tmp", "telegram", "channel-posts.work.json"));
});

test("update journal paths are profile-scoped", () => {
  assert.equal(
    resolveTelegramUpdateJournalPath("/agent", "default"),
    join("/agent", "tmp", "telegram", "inbox.json"),
  );
  assert.equal(
    resolveTelegramUpdateJournalPath("/agent", "work"),
    join("/agent", "tmp", "telegram", "inbox.work.json"),
  );
});

test("profile-only storage callbacks bind the configured agent directory", () => {
  const agentDir = resolveAgentDir();
  assert.equal(
    resolveTelegramUpdateJournalPathForProfile("work"),
    resolveTelegramUpdateJournalPath(agentDir, "work"),
  );
  assert.equal(
    resolveTelegramWorkspaceAdmissionPathForProfile("work"),
    resolveTelegramWorkspaceAdmissionPath(agentDir, "work"),
  );
  assert.notEqual(
    resolveTelegramUpdateJournalPathForProfile("work"),
    resolveTelegramUpdateJournalPath("work"),
  );
  assert.notEqual(
    resolveTelegramWorkspaceAdmissionPathForProfile("work"),
    resolveTelegramWorkspaceAdmissionPath("work"),
  );
});

await test("follower journal paths are stable binding and profile scoped", () => {
  const first = resolveTelegramFollowerJournalPath(
    "manual-follower:owner-a",
    "/agent",
    "work",
  );
  assert.equal(
    first,
    resolveTelegramFollowerJournalPath(
      "manual-follower:owner-a",
      "/agent",
      "work",
    ),
  );
  assert.notEqual(
    first,
    resolveTelegramFollowerJournalPath(
      "manual-follower:owner-b",
      "/agent",
      "work",
    ),
  );
  assert.match(
    first,
    /follower-inbox-[a-f0-9]{16}\.work\.json$/u,
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
