/**
 * Regression tests for Telegram runtime storage housekeeping
 * Covers legacy recovery-folder removal and orphaned session journal sweeps
 */

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  removeTelegramLegacyRecoveryStorage,
  createTelegramSessionFolderSweeper,
} from "../lib/recovery.ts";
import {
  createTelegramUpdateJournalBindingKey,
  createTelegramUpdateJournalBotIdentity,
  createTelegramUpdateJournalEntryDigest,
  decodeTelegramTextInputSourceJournalCandidate,
} from "../lib/journal.ts";

function createRuntimePaths(): { dir: string } {
  return { dir: mkdtempSync(join(tmpdir(), "pi-telegram-recovery-")) };
}

test("Legacy recovery folders are removed from the runtime root and session folders only", () => {
  const paths = createRuntimePaths();
  try {
    const sessionRecovery = join(paths.dir, "sessions", "session-a", "recovery");
    mkdirSync(join(paths.dir, "recovery", "1-2-x"), { recursive: true });
    writeFileSync(join(paths.dir, "recovery", "1-2-x", "owners.json"), "{truncated");
    mkdirSync(sessionRecovery, { recursive: true });
    writeFileSync(join(paths.dir, "sessions", "session-a", "journal.0123456789abcdef.json"), "{}");
    writeFileSync(join(paths.dir, "recovery-note"), "kept");
    assert.deepEqual(removeTelegramLegacyRecoveryStorage(paths.dir).sort(), [join(paths.dir, "recovery"), sessionRecovery].sort());
    assert.equal(existsSync(join(paths.dir, "recovery")), false);
    assert.equal(existsSync(sessionRecovery), false);
    assert.equal(readFileSync(join(paths.dir, "sessions", "session-a", "journal.0123456789abcdef.json"), "utf8"), "{}");
    assert.equal(readFileSync(join(paths.dir, "recovery-note"), "utf8"), "kept");
    assert.deepEqual(removeTelegramLegacyRecoveryStorage(paths.dir), [], "Idempotent");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

function protectedCandidate(path: string): string {
  const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "123:recovery-fixture", botId: 123 });
  const entry = { updateId: 1, update: { update_id: 1, message: { message_id: 11,
    from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, message_thread_id: 9, text: "Original A" } },
    preApprovalExcluded: false, admittedAtMs: 1, state: "pending" as const };
  const serialized = JSON.stringify({ version: 5, revision: 1, acceptedThroughUpdateId: 1, profile: "work", botIdentity,
    entries: [{ ...entry, privateTextInput: {
      source: { journalBindingKey: createTelegramUpdateJournalBindingKey({ path, profileName: "work", botIdentity }),
        tokenSha256: botIdentity.tokenSha256, updateId: 1 },
      expectedSource: createTelegramUpdateJournalEntryDigest(entry), requestNonce: "a".repeat(32), operatorUserId: 7,
      target: { chatId: 7, threadId: 9 }, receiver: { instanceId: "original-a", processId: process.pid,
        processBirthId: `${process.pid}:fixture-birth`, sessionGeneration: 1, sessionId: "original-a",
        bindingKey: "workspace:original-a", deliveryGeneration: "original-generation" },
    } }] });
  assert.equal(decodeTelegramTextInputSourceJournalCandidate(serialized, path).entries[0]!.privateTextInput!.requestNonce, "a".repeat(32));
  return serialized;
}

function retainedTree(directory: string): unknown[] {
  return readdirSync(directory).sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    return { name, dev: stat.dev, ino: stat.ino, mode: stat.mode,
      value: stat.isDirectory() ? retainedTree(path) : readFileSync(path).toString("hex") };
  });
}

for (const shape of ["protected-v5", "malformed-v5", "torn", "unmarked", "segments-only", "retained-only", "empty"] as const)
test(`Private session sweep hold preserves all family history (${shape})`, () => {
  const paths = createRuntimePaths();
  try {
    const sessions = join(paths.dir, "sessions"), folder = join(sessions, "original-a");
    const path = join(folder, "journal.0123456789abcdef.work.json");
    mkdirSync(folder, { recursive: true });
    if (shape === "protected-v5") writeFileSync(path, protectedCandidate(path));
    if (shape === "malformed-v5") writeFileSync(path, '{"version":5,"unknown":true}');
    if (shape === "torn") writeFileSync(path, '{"ver');
    if (shape === "unmarked") writeFileSync(path, '{}');
    if (shape !== "empty") {
      const residue = `${path}${shape === "retained-only" ? ".retained" : ".segments"}`;
      mkdirSync(residue);
      writeFileSync(join(residue, "unknown.json"), "unclassified original bytes");
    }
    const before = retainedTree(sessions);
    let now = 0, kept = ["original-a"];
    const deps: Parameters<typeof createTelegramSessionFolderSweeper>[0] = { getSessionsDir: () => sessions,
      getProfileName: () => "work", getKeptSessionIds: () => kept, getNowMs: () => now, intervalMs: 1,
      preserveJournalFamilies: true };
    const sweeper = createTelegramSessionFolderSweeper(deps);
    assert.deepEqual(sweeper.sweep(), []);
    assert.deepEqual(retainedTree(sessions), before);
    kept = []; now = 10_000_000; delete deps.preserveJournalFamilies;
    assert.deepEqual(sweeper.sweep(), [], "Losing keep-set, time or the mutable option cannot release the hold");
    assert.deepEqual(retainedTree(sessions), before, "No snapshot, orphan residue, namespace or inode may be removed/recreated");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Private session sweep hold is captured once and does not invoke observation ports", () => {
  let reads = 0, observations = 0;
  const unexpected = (): never => { observations++; throw new Error("held sweep observed a port"); };
  const deps: Parameters<typeof createTelegramSessionFolderSweeper>[0] = {
    getSessionsDir: unexpected, getProfileName: unexpected, getKeptSessionIds: unexpected, getNowMs: unexpected,
    get preserveJournalFamilies(): true | undefined { reads++; return reads === 1 ? true : undefined; },
  };
  const sweeper = createTelegramSessionFolderSweeper(deps);
  assert.doesNotThrow(() => assert.deepEqual(sweeper.sweep(), []));
  assert.doesNotThrow(() => assert.deepEqual(sweeper.sweep(), []));
  assert.equal(reads, 1); assert.equal(observations, 0);
});

test("Private session sweep hold rejects nonliteral runtime options before cleanup", () => {
  let observations = 0;
  const unexpected = (): never => { observations++; throw new Error("invalid hold observed a port"); };
  for (const value of [false, null, 0, 1, "true", {}, () => true]) {
    assert.throws(() => createTelegramSessionFolderSweeper({ getSessionsDir: unexpected, getProfileName: unexpected,
      getKeptSessionIds: unexpected, preserveJournalFamilies: value } as unknown as Parameters<typeof createTelegramSessionFolderSweeper>[0]),
    /preservation must be true or omitted/u);
  }
  assert.equal(observations, 0);
});

test("Private session sweep hold is not a durable pin or authority over a separate default sweeper", () => {
  const paths = createRuntimePaths();
  try {
    const sessions = join(paths.dir, "sessions"), folder = join(sessions, "original-a");
    const path = join(folder, "journal.0123456789abcdef.work.json");
    mkdirSync(folder, { recursive: true }); writeFileSync(path, protectedCandidate(path));
    const deps: Parameters<typeof createTelegramSessionFolderSweeper>[0] = {
      getSessionsDir: () => sessions, getProfileName: () => "work", getKeptSessionIds: () => [], getNowMs: () => 1 };
    const held = createTelegramSessionFolderSweeper({ ...deps, preserveJournalFamilies: true });
    assert.deepEqual(held.sweep(), []); assert.ok(existsSync(path));
    const defaultSweeper = createTelegramSessionFolderSweeper(deps);
    deps.preserveJournalFamilies = true;
    assert.ok(defaultSweeper.sweep().includes(path), "A later option cannot retrofit an already-created default sweeper"); assert.equal(existsSync(path), false);
    assert.deepEqual(held.sweep(), [], "A held no-op cannot infer, repair or recreate historical source data");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("Session sweeper removes unbound current-profile journals and empty folders only", () => {
  const paths = createRuntimePaths();
  try {
    const sessions = join(paths.dir, "sessions");
    const family = (session: string, profileSuffix = "") => {
      mkdirSync(join(sessions, session, `journal.0123456789abcdef${profileSuffix}.json.segments`), { recursive: true });
      writeFileSync(join(sessions, session, `journal.0123456789abcdef${profileSuffix}.json`), "{}");
    };
    family("bound"); family("unbound"); family("shared"); family("shared", ".other"); family("live");
    mkdirSync(join(sessions, "%61"), { recursive: true });
    let now = 0, kept: (string | undefined)[] = ["bound", "live", undefined];
    const sweeper = createTelegramSessionFolderSweeper({ getSessionsDir: () => sessions, getProfileName: () => "default",
      getKeptSessionIds: () => kept, getNowMs: () => now, intervalMs: 1000 });
    const removed = sweeper.sweep();
    assert.deepEqual(readdirSync(sessions).sort(), ["%61", "bound", "live", "shared"].sort(),
      "Unbound folder removed; noncanonical names untouched");
    assert.deepEqual(readdirSync(join(sessions, "shared")).sort(), ["journal.0123456789abcdef.other.json", "journal.0123456789abcdef.other.json.segments"],
      "Another profile's family keeps the shared folder");
    assert.ok(removed.includes(join(sessions, "unbound")));
    kept = ["live"];
    now = 500;
    assert.deepEqual(sweeper.sweep(), [], "Throttled between sweeps");
    now = 1000;
    sweeper.sweep();
    assert.deepEqual(readdirSync(sessions).sort(), ["%61", "live", "shared"].sort(), "A session that lost its slot is swept later");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
