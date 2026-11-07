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
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Node eval child did not exit. stdout=${stdout} stderr=${stderr}`,
        ),
      );
    }, options.timeoutMs ?? 5000);
    timeout.unref?.();
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Early option/launch refusal can close stdin before the fixture source is consumed.
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error);
    });
    // Keep eval/import/argv semantics without putting large fixtures in the Windows command line.
    child.stdin.end(source);
  });
}
