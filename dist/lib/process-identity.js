/**
 * Process identity and liveness proofs
 * Zones: shared utils, multi-instance bus, durable admission
 * Owns PID liveness probes and stable Linux/macOS/Windows process-birth identity. Only an absent PID or a
 * mismatched birth proof establishes death; inaccessible metadata stays unverifiable.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { platform as getPlatform } from "node:os";
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // Only an absent PID proves death; permission and unexpected failures do not.
        return error.code !== "ESRCH";
    }
}
function readDarwinProcessStart(pid) {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}
/** Creation time in UTC 100 ns ticks; PowerShell ships with every supported Windows and needs no native addon. */
function readWindowsProcessStart(pid) {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return execFileSync(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
    }).trim();
}
/** A successful self-proof is immutable; do not repeat shell probes inside admission transactions. */
const ownBirthProofs = new Map();
function getTelegramProcessBirthProof(pid, options = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return { status: "unverifiable" };
    const platform = options.platform ?? getPlatform();
    if (platform === "linux") {
        try {
            const stat = (options.readProcStat ??
                ((targetPid) => readFileSync(`/proc/${targetPid}/stat`, "utf8")))(pid);
            const closeParen = stat.lastIndexOf(")");
            const fields = stat
                .slice(closeParen + 2)
                .trim()
                .split(/\s+/u);
            const startTicks = fields[19];
            if (startTicks) {
                return { status: "proven", identity: `${pid}:start:${startTicks}` };
            }
        }
        catch {
            /* inaccessible process metadata */
        }
    }
    else if (platform === "darwin") {
        const cacheable = pid === process.pid && !options.readDarwinProcessStart;
        const cached = cacheable && ownBirthProofs.get(platform);
        if (cached)
            return cached;
        try {
            const startedAt = (options.readDarwinProcessStart ?? readDarwinProcessStart)(pid);
            if (startedAt) {
                const fingerprint = createHash("sha256")
                    .update(startedAt)
                    .digest("hex")
                    .slice(0, 16);
                const proof = { status: "proven", identity: `${pid}:start:${fingerprint}` };
                if (cacheable)
                    ownBirthProofs.set(platform, proof);
                return proof;
            }
        }
        catch {
            /* inaccessible process metadata */
        }
    }
    else if (platform === "win32") {
        const injected = options.readWindowsProcessStart;
        const cacheable = pid === process.pid && !injected;
        const cached = cacheable && ownBirthProofs.get(platform);
        if (cached)
            return cached;
        let proof = { status: "unverifiable" };
        try {
            const ticks = (injected ?? readWindowsProcessStart)(pid);
            if (/^\d+$/u.test(ticks))
                proof = { status: "proven", identity: `${pid}:start:${ticks}` };
        }
        catch {
            /* inaccessible process metadata, including another user's process */
        }
        if (cacheable && proof.status === "proven")
            ownBirthProofs.set(platform, proof);
        return proof;
    }
    return { status: "unverifiable" };
}
export function getTelegramProcessBirthIdentity(pid, fallbackGeneration, options = {}) {
    const proof = getTelegramProcessBirthProof(pid, options);
    return proof.status === "proven"
        ? proof.identity
        : `${pid}:generation:${fallbackGeneration}`;
}
export function getTelegramProcessLiveness(owner, options = {}) {
    const processAlive = options.isProcessAlive ?? isProcessAlive;
    if (!processAlive(owner.processId))
        return "dead";
    const proof = getTelegramProcessBirthProof(owner.processId, options);
    if (proof.status === "unverifiable")
        return "unverifiable";
    return proof.identity === owner.processBirthId ? "alive" : "dead";
}
export function getTelegramProcessBirthIdentityLiveness(processBirthId, options = {}) {
    const match = /^(\d+):(start|generation):(.+)$/u.exec(processBirthId);
    if (!match)
        return "unverifiable";
    const processId = Number(match[1]);
    if (!Number.isSafeInteger(processId) || processId <= 0)
        return "unverifiable";
    const processAlive = options.isProcessAlive ?? isProcessAlive;
    if (!processAlive(processId))
        return "dead";
    if (match[2] === "generation")
        return "unverifiable";
    const proof = getTelegramProcessBirthProof(processId, options);
    if (proof.status === "unverifiable")
        return "unverifiable";
    return proof.identity === processBirthId ? "alive" : "dead";
}
