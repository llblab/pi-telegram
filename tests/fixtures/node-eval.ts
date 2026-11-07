/**
 * Node eval child-process fixture
 * Zones: test infrastructure, process isolation, cross-process regressions
 * Owns bounded Node subprocess execution and stdout/stderr capture for domain race tests
 */

import { spawn } from "node:child_process";

export interface NodeEvalOptions {
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  timeoutMs?: number;
  readiness?: { stdoutPrefix: string; startupTimeoutMs: number };
}

export interface NodeEvalResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runNodeEval(
  source: string,
  options: NodeEvalOptions = {},
): Promise<NodeEvalResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const readiness = options.readiness ? { ...options.readiness } : undefined;
  if (readiness && (!readiness.stdoutPrefix || /[\r\n]/u.test(readiness.stdoutPrefix) || !Number.isFinite(readiness.startupTimeoutMs) || readiness.startupTimeoutMs <= 0))
    throw new Error("Node eval readiness requires one line prefix and a positive startup bound");
  const child = spawn(
    process.execPath,
    [
      ...(options.nodeArgs ?? []),
      "--experimental-strip-types",
      "--input-type=module",
    ],
    {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let ready = !readiness;
    let timeout: ReturnType<typeof setTimeout>;
    let total: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timeout); clearTimeout(total); };
    const fail = () => {
      clear(); child.kill("SIGKILL");
      reject(new Error(`Node eval child did not exit (${ready ? "execution/drain" : "startup"}). stdout=${stdout} stderr=${stderr}`));
    };
    timeout = setTimeout(fail, readiness?.startupTimeoutMs ?? timeoutMs);
    timeout.unref?.();
    if (readiness) { total = setTimeout(fail, readiness.startupTimeoutMs + timeoutMs); total.unref?.(); }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!ready && readiness && stdout.split(/\r?\n/u).some(line => line.startsWith(readiness.stdoutPrefix))) {
        ready = true; clearTimeout(timeout); timeout = setTimeout(fail, timeoutMs); timeout.unref?.();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clear(); reject(error); });
    child.on("close", (code, signal) => {
      clear();
      if (!ready) { reject(new Error(`Node eval child closed before readiness. stdout=${stdout} stderr=${stderr}`)); return; }
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Early option/launch refusal can close stdin before the fixture source is consumed.
      if (error.code === "EPIPE" || error.code === "EOF" || error.code === "ERR_STREAM_DESTROYED") return;
      clear(); child.kill("SIGKILL"); reject(error);
    });
    // Keep eval/import/argv semantics without putting large fixtures in the Windows command line.
    child.stdin.end(source);
  });
}
