/**
 * Regression tests for the loop-lag domain
 * Covers lib/loop-lag.ts sync-block totals, drift-based stall detection, windowed attribution and monitor lifecycle
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramEventLoopLagMonitor,
  readTelegramSyncBlockTotals,
  recordTelegramSyncBlock,
  type TelegramEventLoopStall,
} from "../lib/loop-lag.ts";

function createHarness(thresholdMs = 1_000) {
  let now = 10_000;
  let cpu = 0;
  let tick: (() => void) | undefined;
  let cancelled = 0;
  const stalls: TelegramEventLoopStall[] = [];
  const monitor = createTelegramEventLoopLagMonitor({
    thresholdMs,
    intervalMs: 250,
    getNowMs: () => now,
    readCpuMs: () => cpu,
    schedule: (callback) => {
      tick = callback;
      return () => { cancelled += 1; tick = undefined; };
    },
    record: (stall) => { stalls.push(stall); },
  });
  return {
    monitor, stalls,
    advance(ms: number, cpuMs = 0) { now += ms; cpu += cpuMs; tick?.(); },
    get cancelled() { return cancelled; },
    get scheduled() { return tick !== undefined; },
  };
}

test("Event loop lag monitor stays silent while timers fire on schedule", () => {
  const h = createHarness();
  h.monitor.start();
  for (let i = 0; i < 20; i++) h.advance(250);
  h.advance(250 + 999);
  assert.deepEqual(h.stalls, [], "Drift below the threshold is not a stall");
  h.monitor.stop();
});

test("Event loop lag monitor reports only blocking inside each window, including its maximum", (t) => {
  const label = `lag-test-${Math.random()}`;
  const h = createHarness();
  t.after(() => h.monitor.stop());
  recordTelegramSyncBlock(label, 5_000);
  h.monitor.start();
  recordTelegramSyncBlock(label, 40);
  recordTelegramSyncBlock(label, 1_800);
  h.advance(250 + 2_600, 40);
  assert.equal(h.stalls.length, 1);
  assert.equal(h.stalls[0]!.lagMs, 2_600);
  assert.equal(h.stalls[0]!.cpuMs, 40, "Low CPU during a long stall points at waiting, not computation");
  assert.deepEqual(h.stalls[0]!.blocked[label], { ms: 1_840, count: 2, maxMs: 1_800 }, "Blocking before the window is excluded");
  h.advance(250);
  assert.equal(h.stalls.length, 1, "The next on-time tick starts a fresh window");
  recordTelegramSyncBlock(label, 10);
  h.advance(250 + 1_200);
  assert.equal(h.stalls.length, 2);
  assert.deepEqual(h.stalls[1]!.blocked[label], { ms: 10, count: 1, maxMs: 10 }, "A previous window's maximum is excluded");
  h.advance(250 + 1_200);
  assert.equal(h.stalls.length, 3);
  assert.equal(h.stalls[2]!.blocked[label], undefined, "A stall without reported blocking names no cause");
  assert.deepEqual(h.stalls[0]!.blocked[label], { ms: 1_840, count: 2, maxMs: 1_800 }, "Later windows cannot mutate an earlier report");
  assert.equal(readTelegramSyncBlockTotals()[label]!.maxMs, 5_000, "Window resets preserve process-wide counters");
});

test("Event loop lag monitors keep independent windows across quiet ticks, stop and restart", (t) => {
  const label = `independent-windows-${Math.random()}`;
  const first = createHarness(), second = createHarness();
  t.after(() => { first.monitor.stop(); second.monitor.stop(); });
  first.monitor.start();
  recordTelegramSyncBlock(label, 100);
  second.monitor.start();
  recordTelegramSyncBlock(label, 10);
  first.advance(250 + 1_200);
  second.advance(250 + 1_200);
  assert.deepEqual(first.stalls[0]!.blocked[label], { ms: 110, count: 2, maxMs: 100 });
  assert.deepEqual(second.stalls[0]!.blocked[label], { ms: 10, count: 1, maxMs: 10 });
  recordTelegramSyncBlock(label, 40);
  first.advance(250);
  second.advance(250 + 1_200);
  assert.deepEqual(second.stalls[1]!.blocked[label], { ms: 40, count: 1, maxMs: 40 }, "Another monitor's quiet tick cannot consume this window");
  first.advance(250 + 1_200);
  assert.equal(first.stalls[1]!.blocked[label], undefined, "Quiet ticks also close the window");
  recordTelegramSyncBlock(label, 200);
  first.monitor.stop();
  recordTelegramSyncBlock(label, 5_000);
  first.monitor.start();
  recordTelegramSyncBlock(label, 5);
  first.advance(250 + 1_200);
  second.advance(250 + 1_200);
  assert.deepEqual(first.stalls[2]!.blocked[label], { ms: 5, count: 1, maxMs: 5 }, "Restart discards the old and stopped windows");
  assert.deepEqual(second.stalls[2]!.blocked[label], { ms: 5_205, count: 3, maxMs: 5_000 }, "Another monitor's restart cannot reset this window");
});

test("Event loop lag monitor restarts cleanly, cancels on stop and survives a throwing sink", () => {
  let now = 0;
  let tick: (() => void) | undefined;
  let cancels = 0;
  const monitor = createTelegramEventLoopLagMonitor({
    thresholdMs: 100, intervalMs: 50, getNowMs: () => now,
    schedule: (callback) => { tick = callback; return () => { cancels += 1; }; },
    record: () => { throw new Error("sink failed"); },
  });
  monitor.start();
  monitor.start();
  assert.equal(cancels, 1, "Starting again replaces the previous schedule");
  now = 500;
  assert.doesNotThrow(() => tick!(), "A failing sink never reaches the timer callback");
  monitor.stop();
  monitor.stop();
  assert.equal(cancels, 2);
});

test("Sync block totals accumulate per label and expose copies", () => {
  const label = `totals-test-${Math.random()}`;
  recordTelegramSyncBlock(label, 3);
  recordTelegramSyncBlock(label, 9);
  recordTelegramSyncBlock(label, -1);
  recordTelegramSyncBlock(label, Number.NaN);
  const totals = readTelegramSyncBlockTotals()[label]!;
  assert.deepEqual(totals, { ms: 12, count: 2, maxMs: 9 });
  (totals as { ms: number }).ms = 0;
  assert.equal(readTelegramSyncBlockTotals()[label]!.ms, 12, "Mutating a read copy never changes the counters");
});

test("Event loop lag monitor reports CPU-bound stalls and tolerates an unreadable CPU clock", () => {
  let now = 0;
  let cpu = 0;
  let tick: (() => void) | undefined;
  let cpuReadable = true;
  const stalls: TelegramEventLoopStall[] = [];
  const monitor = createTelegramEventLoopLagMonitor({
    thresholdMs: 100, intervalMs: 50, getNowMs: () => now,
    readCpuMs: () => { if (!cpuReadable) throw new Error("no cpu clock"); return cpu; },
    schedule: (callback) => { tick = callback; return () => {}; },
    record: (stall) => { stalls.push(stall); },
  });
  monitor.start();
  now = 3_050; cpu = 2_900; tick!();
  assert.equal(stalls[0]!.cpuMs, 2_900, "CPU near the lag marks a busy loop");
  cpuReadable = false;
  now = 6_100; tick!();
  assert.equal(stalls.length, 2);
  assert.equal(Object.hasOwn(stalls[1]!, "cpuMs"), false, "An unreadable CPU clock omits the field instead of failing");
  monitor.stop();
});
