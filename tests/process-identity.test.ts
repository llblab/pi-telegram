/**
 * Process identity and liveness regressions
 * Zones: shared utils, multi-instance bus, durable admission
 * Covers PID absence, stable Linux/macOS birth proofs and fail-closed unverifiable outcomes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runNodeEval } from "./fixtures/node-eval.ts";

import {
  getTelegramProcessBirthIdentity,
  getTelegramProcessBirthIdentityLiveness,
  getTelegramProcessLiveness,
  isProcessAlive,
} from "../lib/process-identity.ts";

test("Process absence requires ESRCH rather than an unknown liveness error", (t) => {
  let code: string | undefined;
  t.mock.method(process, "kill", () => {
    if (code) throw Object.assign(new Error("liveness unavailable"), { code });
    return true;
  });
  for (code of [undefined, "ESRCH", "EPERM", "EACCES", "EINVAL", "unknown"]) {
    assert.equal(isProcessAlive(42), code !== "ESRCH", String(code));
  }
});

test("Darwin process birth identity survives extension generations", () => {
  const options = {
    platform: "darwin" as const,
    readDarwinProcessStart: () => "Wed Jul 29 16:19:07 2026",
  };
  const first = getTelegramProcessBirthIdentity(75433, 1000, options);
  const reloaded = getTelegramProcessBirthIdentity(75433, 2000, options);

  assert.equal(reloaded, first);
  assert.match(first, /^75433:start:[a-f0-9]{16}$/u);
});

for (const artifact of ["source", "compiled"] as const) {
  test(`Darwin native self-proof is reused without caching peer, failed or injected evidence (${artifact})`, async () => {
    const module = new URL(artifact === "source" ? "../lib/process-identity.ts" : "../dist/lib/process-identity.js", import.meta.url);
    const result = await runNodeEval(`
      import assert from "node:assert/strict";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const child = createRequire(import.meta.url)("node:child_process"), self = process.pid, peer = self + 1;
      const calls = [];
      let selfReady = false, peerChanged = false;
      child.execFileSync = (command, args) => {
        assert.equal(command, "/bin/ps");
        const pid = Number(args.at(-1));
        assert.deepEqual(args, ["-o", "lstart=", "-p", String(pid)]);
        calls.push(pid);
        if (pid === self && !selfReady) throw new Error("unavailable self proof");
        return pid === peer && peerChanged ? "different peer birth" : "original native birth";
      };
      syncBuiltinESMExports();
      const Process = await import(${JSON.stringify(module.href)});
      let alive = true;
      const options = { platform: "darwin", isProcessAlive: () => alive };
      assert.equal(Process.getTelegramProcessBirthIdentity(self, "fallback", options), self + ":generation:fallback");
      selfReady = true;
      const birth = Process.getTelegramProcessBirthIdentity(self, "original", options);
      assert.match(birth, /:start:[a-f0-9]{16}$/u);
      for (let i = 0; i < 16; i++) {
        assert.equal(Process.getTelegramProcessBirthIdentity(self, i, options), birth);
        assert.equal(Process.getTelegramProcessLiveness({ processId: self, processBirthId: birth }, options), "alive");
        assert.equal(Process.getTelegramProcessBirthIdentityLiveness(birth, options), "alive");
      }
      const artificial = { ...options, readDarwinProcessStart: () => "injected birth" };
      assert.notEqual(Process.getTelegramProcessBirthIdentity(self, "artificial", artificial), birth);
      assert.equal(Process.getTelegramProcessBirthIdentity(self, "after injection", options), birth);
      const peerBirth = Process.getTelegramProcessBirthIdentity(peer, "peer", options);
      peerChanged = true;
      assert.equal(Process.getTelegramProcessLiveness({ processId: peer, processBirthId: peerBirth }, options), "dead");
      alive = false;
      assert.equal(Process.getTelegramProcessBirthIdentityLiveness(birth, options), "dead");
      assert.deepEqual(calls, [self, self, peer, peer]);
    `);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  });
}

test(
  "Current Darwin process birth identity survives extension generations",
  { skip: process.platform !== "darwin" },
  () => {
    const first = getTelegramProcessBirthIdentity(process.pid, 1000);
    const reloaded = getTelegramProcessBirthIdentity(process.pid, 2000);

    assert.equal(reloaded, first);
    assert.match(first, new RegExp(`^${process.pid}:start:[a-f0-9]{16}$`, "u"));
  },
);

test("Windows process birth identity uses creation ticks and proves reuse", () => {
  const options = (ticks: string | Error) => ({
    platform: "win32" as const,
    isProcessAlive: () => true,
    readWindowsProcessStart: () => {
      if (ticks instanceof Error) throw ticks;
      return ticks;
    },
  });
  assert.equal(getTelegramProcessBirthIdentity(4242, 1000, options("638123456789012345")), "4242:start:638123456789012345");
  assert.equal(getTelegramProcessBirthIdentity(4242, 2000, options("638123456789012345")), "4242:start:638123456789012345",
    "the identity survives extension generations");
  const owner = { processId: 4242, processBirthId: "4242:start:638123456789012345" };
  assert.equal(getTelegramProcessLiveness(owner, options("638123456789012345")), "alive");
  assert.equal(getTelegramProcessLiveness(owner, options("638999999999999999")), "dead", "a reused PID with a new birth is dead");
  assert.equal(getTelegramProcessLiveness(owner, options("not ticks")), "unverifiable");
  assert.equal(getTelegramProcessLiveness(owner, options(new Error("access denied"))), "unverifiable");
  assert.equal(getTelegramProcessBirthIdentity(1.5, "g", options("1")), "1.5:generation:g", "only integral PIDs reach the command");
});

test(
  "Current Windows process birth identity is proven and stable",
  { skip: process.platform !== "win32" },
  () => {
    const first = getTelegramProcessBirthIdentity(process.pid, 1000);
    const reloaded = getTelegramProcessBirthIdentity(process.pid, 2000);
    assert.equal(reloaded, first);
    assert.match(first, new RegExp(`^${process.pid}:start:\\d+$`, "u"));
    assert.equal(getTelegramProcessLiveness({ processId: process.pid, processBirthId: first }), "alive");
  },
);

test("Process liveness requires a stable platform birth proof", () => {
  const linuxStat = (ticks: string) =>
    `(worker name) S ${Array(18).fill("0").join(" ")} ${ticks}`;
  assert.equal(
    getTelegramProcessLiveness(
      { processId: 42, processBirthId: "42:start:12345" },
      {
        platform: "linux",
        isProcessAlive: () => true,
        readProcStat: () => linuxStat("12345"),
      },
    ),
    "alive",
  );
  assert.equal(
    getTelegramProcessLiveness(
      { processId: 42, processBirthId: "42:start:old" },
      {
        platform: "linux",
        isProcessAlive: () => true,
        readProcStat: () => linuxStat("new"),
      },
    ),
    "dead",
  );
  assert.equal(
    getTelegramProcessLiveness(
      { processId: 42, processBirthId: "42:generation:owner" },
      { platform: "win32", isProcessAlive: () => true },
    ),
    "unverifiable",
  );
  assert.equal(
    getTelegramProcessLiveness(
      { processId: 42, processBirthId: "42:start:any" },
      { platform: "win32", isProcessAlive: () => false },
    ),
    "dead",
  );
  assert.equal(
    getTelegramProcessLiveness(
      { processId: 42, processBirthId: "42:start:any" },
      {
        platform: "darwin",
        isProcessAlive: () => true,
        readDarwinProcessStart: () => {
          throw new Error("inaccessible");
        },
      },
    ),
    "unverifiable",
  );
});

test("Process birth identity liveness fails closed for opaque and live fallback identities", () => {
  const stat = `(worker) S ${Array(18).fill("0").join(" ")} 12345`;
  const options = { platform: "linux" as const, isProcessAlive: () => true,
    readProcStat: () => stat };
  assert.equal(getTelegramProcessBirthIdentityLiveness("42:start:12345", options), "alive");
  assert.equal(getTelegramProcessBirthIdentityLiveness("42:start:999", options), "dead");
  assert.equal(getTelegramProcessBirthIdentityLiveness("42:generation:fallback", options), "unverifiable");
  assert.equal(getTelegramProcessBirthIdentityLiveness("opaque", options), "unverifiable");
  assert.equal(getTelegramProcessBirthIdentityLiveness("42:start:12345", {
    ...options, isProcessAlive: () => false,
  }), "dead");
});

test("Process birth identity preserves Linux start ticks and fallback", () => {
  const stat = `(worker name) S ${Array(18).fill("0").join(" ")} 12345`;
  assert.equal(
    getTelegramProcessBirthIdentity(42, 1000, {
      platform: "linux",
      readProcStat: () => stat,
    }),
    "42:start:12345",
  );
  assert.equal(
    getTelegramProcessBirthIdentity(42, 1000, {
      platform: "darwin",
      readDarwinProcessStart: () => "",
    }),
    "42:generation:1000",
  );
});
