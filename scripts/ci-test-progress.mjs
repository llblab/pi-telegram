/**
 * Finite body-free projection of public Node test events beside the native CI reporter.
 * Zones: CI, test reporting
 * Owns observational records only, not test execution, native outcomes, body drain or GitHub retention.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const countKeys = ["tests", "passed", "failed", "cancelled", "skipped", "todo"];
const counter = value => Number.isSafeInteger(value) && value >= 0;
const reasonFlag = value => value === undefined || typeof value === "boolean" || typeof value === "string";
const flagged = value => value !== undefined && value !== false;

export function createNativeTestProgressProjection(file) {
  if (typeof file !== "string" || !file) throw new TypeError("A native test file scope is required");
  let dequeued = 0, nativeCompleted = 0, milestones = 0, firstFailure = false, stopped = false;
  let active;
  const unavailable = reason => {
    stopped = true;
    return { v: 1, phase: "unavailable", reason, dequeued, nativeCompleted };
  };
  return event => {
    if (stopped || !event || !["test:dequeue", "test:complete", "test:summary"].includes(event.type)) return;
    const data = event.data;
    if (!data || data.file !== file) return;
    if (event.type === "test:summary") {
      const counts = data.counts;
      if (!counts || !countKeys.every(key => counter(counts[key])) || typeof data.success !== "boolean") return unavailable("event-shape");
      if (active || counts.tests !== dequeued || nativeCompleted !== dequeued) return unavailable("sequence");
      stopped = true;
      return { v: 1, phase: "native-summary", dequeued, nativeCompleted, success: data.success,
        counts: { tests: counts.tests, passed: counts.passed, failed: counts.failed, cancelled: counts.cancelled, skipped: counts.skipped, todo: counts.todo } };
    }
    // Node emits a file wrapper with the same file/nesting/type as its top-level tests.
    if (typeof data.name === "string" && data.name.length <= 512 && data.line === 1 && data.column === 1 && data.nesting === 0 && resolve(data.name) === file) return;
    if (data.nesting !== 0 || data.line === undefined || data.type === "suite" || data.details?.type === "suite") return;
    if (!counter(data.line) || !data.line || !counter(data.column) || !data.column || typeof data.name !== "string" || data.name.length > 512) return unavailable("event-shape");
    const id = createHash("sha256").update(data.name).digest("hex");
    if (event.type === "test:dequeue") {
      if (data.type !== "test") return unavailable("event-shape");
      if (active || !counter(dequeued + 1)) return unavailable("sequence");
      active = { id, line: data.line, column: data.column };
      dequeued++;
      if (milestones < 6 && (dequeued === 1 || dequeued % 64 === 0)) {
        milestones++;
        return { v: 1, phase: "dequeued", dequeued, nativeCompleted, id };
      }
      return;
    }
    const details = data.details;
    if (!details || typeof details.passed !== "boolean" || !reasonFlag(data.skip) || !reasonFlag(data.todo)) return unavailable("event-shape");
    if (!active || active.id !== id || active.line !== data.line || active.column !== data.column) return unavailable("sequence");
    active = undefined;
    nativeCompleted++;
    const skip = flagged(data.skip), todo = flagged(data.todo);
    // Native timeout/failure completion is not callback or descendant settlement.
    if (!details.passed && !skip && !todo && !firstFailure) {
      firstFailure = true;
      return { v: 1, phase: "native-test-failed", dequeued, nativeCompleted, id };
    }
  };
}

export default async function* nativeTestProgress(events) {
  const project = createNativeTestProgressProjection(resolve("tests/integration.test.ts"));
  const github = process.env.GITHUB_ACTIONS === "true";
  for await (const event of events) {
    const record = project(event);
    if (!record) continue;
    const json = JSON.stringify(record);
    // GitHub's public command framing; the title is constant and only the finite projection enters data.
    yield github ? `::notice title=CI native progress::${json.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`
      : `ci-native-progress:${json}\n`;
  }
}
