/**
 * Assemble one host-matched private kernel image; build tooling, never runtime installation.
 * Zones: native build artifacts, package identity
 * Usage (repository checkout): node scripts/package-native-lock.mjs --binary <compiled.node> --out <new-directory>
 * No download, compiler, Pi import, backend activation or configured storage lookup.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
assert.ok(args.length === 4 && args[0] === "--binary" && args[2] === "--out", "Expected one compiled image and a fresh output directory");
assert.ok(["linux", "darwin", "win32"].includes(process.platform) && process.arch === "x64", "Unqualified native packaging target");
const binary = resolve(args[1]), output = resolve(args[3]);
const sourcePath = fileURLToPath(new URL("../native/locks.c", import.meta.url));
for (const path of [binary, sourcePath]) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 10 * 1024 * 1024,
    "Package only bounded single-link regular build inputs");
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const binaryBytes = readFileSync(binary), sourceBytes = readFileSync(sourcePath);
// Non-recursive exclusive creation never overwrites another package or clears failed evidence.
mkdirSync(output, { mode: 0o700 });
const image = join(output, "locks.node");
copyFileSync(binary, image);
writeFileSync(join(output, "locks.c"), sourceBytes, { flag: "wx" });
assert.equal(digest(readFileSync(image)), digest(binaryBytes), "Copied image must preserve the original build bytes");
const native = createRequire(import.meta.url)(image);
assert.equal(native.backendKind, `pi-telegram-kernel-v1-${process.platform}`);
assert.equal(native.napi, 8, "Distributable images require the frozen N-API level");
assert.deepEqual(Reflect.ownKeys(native).sort(), ["backendKind", "napi", "release", "tryAcquire"], "No fixture/fault or raw-resource API may enter a distributable image");
for (const method of ["tryAcquire", "release"]) assert.equal(typeof native[method], "function");
const binarySha256 = digest(binaryBytes);
assert.equal(digest(readFileSync(image)), binarySha256, "Image identity cannot change during package inspection");
assert.equal(digest(readFileSync(sourcePath)), digest(sourceBytes), "Native source cannot change during package assembly");
const manifest = {
  version: 1, backendKind: native.backendKind, platform: process.platform, arch: process.arch,
  napi: 8, minimumNode: "22.19.0", builtWithNode: process.versions.node,
  source: { file: "locks.c", sha256: digest(sourceBytes), bytes: sourceBytes.length },
  binary: { file: "locks.node", sha256: binarySha256, bytes: binaryBytes.length },
};
writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(manifest, null, 2));
