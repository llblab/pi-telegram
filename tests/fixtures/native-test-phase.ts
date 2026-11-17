/**
 * One body-free phase observation at the original native test abort, never a timeout or settlement owner.
 * Zones: CI, test reporting
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { TestContext } from "node:test";

type NativeTestPhase = "fixture" | "invoke" | "sdk-open" | "editor-bind" | "editor-drain" | "replacement" | "assertions" | "cleanup";

export function createNativeTestPhaseObserver(context: Pick<TestContext, "name" | "signal" | "diagnostic">) {
  const id = createHash("sha256").update(context.name).digest("hex"), started = performance.now();
  let phase: NativeTestPhase = "fixture", entered = started, ordinal = 0, finished = false, reported = false;
  const observe = () => {
    if (finished || reported) return;
    reported = true;
    const now = performance.now();
    // A phase says which caller is unsettled, not whether its Worker/body entered or its effects completed.
    const record = { v: 1, phase: "native-test-phase", id, stage: phase, ordinal, pid: process.pid,
      elapsedMs: Math.max(0, Math.floor(now - started)), phaseMs: Math.max(0, Math.floor(now - entered)) };
    try { context.diagnostic(JSON.stringify(record)); } catch { /* Diagnostics cannot replace the native failure. */ }
  };
  context.signal.addEventListener("abort", observe, { once: true });
  if (context.signal.aborted) observe();
  return {
    enter(next: NativeTestPhase) {
      if (finished || reported) return;
      phase = next; entered = performance.now(); ordinal++;
    },
    complete() { finished = true; context.signal.removeEventListener("abort", observe); },
  };
}
