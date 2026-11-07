/**
 * Event-loop stall diagnostics
 * Zones: shared utils
 * Owns process-wide counters of synchronous blocking that callers report and a drift-based stall monitor that
 * attributes each stall to them; knows nothing about locks, transports or who blocked, and never changes behavior
 */
const syncBlocks = new Map();
// A cumulative maximum cannot be differenced; each running monitor owns its current window.
const activeSyncBlockWindows = new Set();
function accumulateSyncBlock(blocks, label, ms) {
    const totals = blocks.get(label) ?? { ms: 0, count: 0, maxMs: 0 };
    totals.ms += ms;
    totals.count += 1;
    if (ms > totals.maxMs)
        totals.maxMs = ms;
    blocks.set(label, totals);
}
/** Reports one synchronous wait or hold that kept the event loop from running. Cheap; safe on any hot path. */
export function recordTelegramSyncBlock(label, ms) {
    if (!(ms >= 0))
        return;
    accumulateSyncBlock(syncBlocks, label, ms);
    for (const window of activeSyncBlockWindows)
        accumulateSyncBlock(window, label, ms);
}
export function readTelegramSyncBlockTotals() {
    return Object.fromEntries([...syncBlocks].map(([label, totals]) => [label, { ...totals }]));
}
const DEFAULT_THRESHOLD_MS = 1_500;
const DEFAULT_INTERVAL_MS = 250;
/** Detects stalls by timer drift: a blocked loop fires the next tick late, by the length of the stall. */
export function createTelegramEventLoopLagMonitor(deps) {
    const thresholdMs = deps.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    const getNowMs = deps.getNowMs ?? Date.now;
    const readCpuMs = deps.readCpuMs ??
        (() => {
            const usage = process.cpuUsage();
            return (usage.user + usage.system) / 1000;
        });
    const safeCpuMs = () => {
        try {
            return readCpuMs();
        }
        catch {
            return undefined;
        }
    };
    let cpuBaselineMs;
    const schedule = deps.schedule ??
        ((tick, every) => {
            const timer = setInterval(tick, every);
            timer.unref?.();
            return () => clearInterval(timer);
        });
    let cancel;
    let expectedAtMs = 0;
    const window = new Map();
    return {
        start() {
            this.stop();
            expectedAtMs = getNowMs() + intervalMs;
            cpuBaselineMs = safeCpuMs();
            cancel = schedule(() => {
                const now = getNowMs();
                const lagMs = now - expectedAtMs;
                expectedAtMs = now + intervalMs;
                const blocked = Object.fromEntries(window);
                window.clear();
                const cpuNowMs = safeCpuMs();
                const cpuMs = cpuNowMs !== undefined && cpuBaselineMs !== undefined
                    ? Math.round(cpuNowMs - cpuBaselineMs)
                    : undefined;
                cpuBaselineMs = cpuNowMs;
                if (lagMs < thresholdMs)
                    return;
                try {
                    deps.record({ lagMs, blocked, ...(cpuMs !== undefined ? { cpuMs } : {}) });
                }
                catch {
                    // Diagnostics cannot escape the timer callback.
                }
            }, intervalMs);
            activeSyncBlockWindows.add(window);
        },
        stop() {
            activeSyncBlockWindows.delete(window);
            window.clear();
            cancel?.();
            cancel = undefined;
        },
    };
}
