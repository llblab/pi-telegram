/**
 * Generative App isolated method worker
 * Zones: managed Generative App execution, bounded local processes
 * Owns one terminable app-method invocation and its child-process cleanup
 */

import { execFile } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

if (!parentPort) throw new Error("Generative App worker requires a parent port.");

const controller = new AbortController();
const runningChildren = new Set();
parentPort.on("message", (message) => {
  if (message?.type !== "abort") return;
  controller.abort();
  for (const child of runningChildren) child.kill();
  parentPort.postMessage({ type: "abort-ack" });
});

function runBoundedProcess(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Generative App run input must be an object.");
  }
  const command = input.command?.trim();
  if (!command) throw new Error("Generative App run.command is required.");
  if (!Array.isArray(input.args ?? []) || (input.args?.length ?? 0) > workerData.runMaxArgs) {
    throw new Error(`Generative App run.args accepts at most ${workerData.runMaxArgs} strings.`);
  }
  const args = (input.args ?? []).map((argument) => {
    if (typeof argument !== "string") throw new Error("Generative App run.args must contain strings.");
    return argument;
  });
  if (!input.cwd || typeof input.cwd !== "string") {
    throw new Error("Generative App run.cwd is required.");
  }
  const timeoutMs = Math.min(
    workerData.runMaxTimeoutMs,
    Math.max(1, Math.round(input.timeoutMs ?? workerData.methodTimeoutMs)),
  );
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: input.cwd,
        encoding: "utf8",
        maxBuffer: workerData.runMaxStreamBytes,
        shell: false,
        signal: controller.signal,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        runningChildren.delete(child);
        if (error && error.code !== "ABORT_ERR") {
          resolve({
            code: typeof error.code === "number" ? error.code : 1,
            killed: error.killed === true,
            stderr: String(stderr).slice(-workerData.runMaxStreamBytes),
            stdout: String(stdout).slice(-workerData.runMaxStreamBytes),
          });
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve({
          code: 0,
          killed: false,
          stderr: String(stderr),
          stdout: String(stdout),
        });
      },
    );
    runningChildren.add(child);
  });
}

try {
  const module = await import(pathToFileURL(workerData.modulePath).href);
  if (typeof module.init !== "function") {
    throw new Error(`Generative App ${workerData.app} must export named function init.`);
  }
  const method = module[workerData.method];
  if (typeof method !== "function") {
    throw new Error(`Generative App ${workerData.app} does not export method ${workerData.method}.`);
  }
  const result = await method({
    ...(workerData.argumentPresent ? { argument: workerData.argument } : {}),
    revision: workerData.revision,
    run: runBoundedProcess,
    signal: controller.signal,
    ...(workerData.statePresent ? { state: workerData.state } : {}),
  });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
