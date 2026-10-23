import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/download-fetch.mjs", import.meta.url));
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const archive = target => `dockpack-cli-${version}-${target}.${target.startsWith("win32") ? "zip" : "tar.gz"}`;

async function inProject(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockpack-download-test-"));
  const log = path.join(root, "requests.log");
  const run = (args, mode = "success") => spawnSync(process.execPath, ["--import", fixture, cli, "download", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", DOWNLOAD_REQUEST_LOG: log, DOWNLOAD_TEST_MODE: mode },
  });
  try { await action({ root, log, run }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("downloads only the requested archive to .dockpack and prints its absolute directory", () => inProject(async ({ root, log, run }) => {
  const result = run(["-p", "linux/amd64"]);
  assert.equal(result.status, 0, result.stderr);
  const filename = archive("linux-x64");
  assert.equal(await readFile(path.join(root, ".dockpack", filename), "utf8"), `archive:${filename}`);
  assert.deepEqual(await readdir(path.join(root, ".dockpack")), [filename]);
  assert.ok(result.stdout.includes(path.join(root, ".dockpack")));
  const requests = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(requests, [`https://github.com/phobal/dockpack/releases/download/v${version}/${filename}`]);
}));

test("accepts multiple values, repeated flags, comma lists and asset platform aliases without duplicate downloads", () => inProject(async ({ root, log, run }) => {
  const result = run(["-p", "linux/amd64", "linux/arm64", "-p", "windows/amd64,darwin/arm64", "-p", "linux-x64", "darwin/amd64"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(path.join(root, ".dockpack"))).length, 5);
  for (const target of ["linux-x64", "linux-arm64", "win32-x64", "darwin-arm64", "darwin-x64"]) {
    assert.equal(await readFile(path.join(root, ".dockpack", archive(target)), "utf8"), `archive:${archive(target)}`);
  }
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 5);
}));

test("rejects unsupported platforms before requesting any files", () => inProject(async ({ root, run }) => {
  const result = run(["-p", "linux/amd64", "linux/riscv64"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported.*linux\/riscv64/i);
  assert.deepEqual(await readdir(root), []);
}));

test("requires explicit platforms when stdin is not interactive", () => inProject(async ({ run }) => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /-p/);
}));

test("interrupted download preserves an existing archive and removes temporary files", () => inProject(async ({ root, run }) => {
  const directory = path.join(root, ".dockpack");
  await mkdir(directory);
  const filename = archive("linux-x64");
  await writeFile(path.join(directory, filename), "existing archive");
  const result = run(["-p", "linux/amd64"], "interrupted");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interrupted/i);
  assert.equal(await readFile(path.join(directory, filename), "utf8"), "existing archive");
  assert.deepEqual(await readdir(directory), [filename]);
}));

for (const mode of ["missing", "interrupted"]) {
  test(`${mode} download fails clearly and leaves no partial files`, () => inProject(async ({ root, run }) => {
    const result = run(["-p", "linux/amd64"], mode);
    assert.equal(result.status, 2);
    assert.match(result.stderr, mode === "missing" ? /404/ : /interrupted/i);
    assert.deepEqual(await readdir(path.join(root, ".dockpack")), []);
  }));
}
