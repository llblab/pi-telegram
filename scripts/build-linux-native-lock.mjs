/**
 * Build the Linux private kernel image in one pinned GLIBC 2.28 toolchain.
 * Zones: native build artifacts, minimum-host qualification
 * Usage (checkout/CI only): node scripts/build-linux-native-lock.mjs --out <new-directory>
 * Docker is build tooling only; no Pi/configured paths, runtime installer or fallback executor.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLinuxNativeImage } from "./package-native-lock.mjs";

assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === "--out");
const lock = JSON.parse(readFileSync(new URL("../native/linux-toolchain.json", import.meta.url), "utf8"));
assert.equal(lock.version, 1); assert.equal(lock.platform, "linux/amd64"); assert.equal(lock.glibcBaseline, "2.28");
assert.match(lock.image, /^quay\.io\/pypa\/manylinux_2_28_x86_64@sha256:[a-f0-9]{64}$/u);
assert.match(lock.configDigest, /^sha256:[a-f0-9]{64}$/u);
assert.match(lock.compiler, /^\/opt\/rh\/gcc-toolset-14\/root\/usr\/bin\/gcc$/u);
const output = resolve(args[1]);
const source = realpathSync(fileURLToPath(new URL("../native/locks.c", import.meta.url)));
const probe = realpathSync(fileURLToPath(new URL("./probe-owned-native-lease.mjs", import.meta.url)));
const node = realpathSync(process.execPath), include = realpathSync(join(dirname(node), "..", "include", "node"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceSha256 = digest(readFileSync(source));
for (const path of [output, source, probe, node, include]) assert.ok(!path.includes(",") && !path.includes("\0"), "Ambiguous Docker bind path");
mkdirSync(output, { mode: 0o700 });
function run(label, command, timeout) {
  const result = spawnSync("docker", command, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  writeFileSync(join(output, `${label}.stdout`), result.stdout ?? "");
  writeFileSync(join(output, `${label}.stderr`), result.stderr ?? "");
  writeFileSync(join(output, `${label}.exit.json`), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message ?? null }));
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
run("pull", ["pull", "--quiet", "--platform", lock.platform, lock.image], 300_000);
const images = JSON.parse(run("inspect", ["image", "inspect", lock.image], 10_000));
assert.equal(images.length, 1);
assert.equal(images[0].Id, lock.configDigest); assert.equal(images[0].Architecture, "amd64"); assert.equal(images[0].Os, "linux");
assert.ok(images[0].RepoDigests.includes(lock.image), "The pulled image must match the frozen registry digest");
const hostProbe = 'const h=process.report.getReport().header;console.log(JSON.stringify({node:process.version,glibc:h.glibcVersionRuntime,arch:process.arch}))';
const command = [
  "set -euo pipefail",
  "getconf GNU_LIBC_VERSION > /out/glibc.txt",
  `${lock.compiler} --version > /out/compiler.txt`,
  `${lock.compiler} -std=c11 -shared -fPIC -Wall -Wextra -Werror -DNAPI_VERSION=8 -DOWNED_LEASE_DISTRIBUTION=1 -I /node-headers /source.c -o /out/distribution.node`,
  `/node -e '${hostProbe}' > /out/minimum-host.json`,
  "/node /probe-owned-native-lease.mjs --backend /out/distribution.node > /out/owner-report.json 2> /out/owner.stderr",
].join("\n");
const bind = (path, target, readonly = true) => ["--mount", `type=bind,source=${path},target=${target}${readonly ? ",readonly" : ""}`];
run("build", ["run", "--rm", "--platform", lock.platform, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "--user", `${process.getuid()}:${process.getgid()}`, "--entrypoint", "/bin/bash", "--env", "TMPDIR=/tmp", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=128m",
  ...bind(source, "/source.c"), ...bind(include, "/node-headers"), ...bind(node, "/node"),
  ...bind(probe, "/probe-owned-native-lease.mjs"), ...bind(output, "/out", false),
  lock.image, "-c", command], 90_000);
const host = JSON.parse(readFileSync(join(output, "minimum-host.json"), "utf8"));
assert.equal(host.glibc, lock.glibcBaseline); assert.equal(host.node, process.version); assert.equal(host.arch, "x64");
assert.equal(readFileSync(join(output, "glibc.txt"), "utf8").trim(), "glibc 2.28");
const owners = JSON.parse(readFileSync(join(output, "owner-report.json"), "utf8"));
assert.equal(owners.node, process.version); assert.equal(owners.fixture, "pi-telegram-kernel-v1-linux"); assert.equal(owners.checks.length, 7);
const binary = join(output, "distribution.node"), binarySha256 = digest(readFileSync(binary));
assert.equal(owners.binarySha256, binarySha256);
assert.equal(digest(readFileSync(source)), sourceSha256, "Build source changed during the container run");
const libc = inspectLinuxNativeImage(binary);
const receipt = { version: 1, image: lock.image, configDigest: lock.configDigest, sourceSha256, binarySha256, host, libc, checks: owners.checks };
writeFileSync(join(output, "build-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(receipt, null, 2));
