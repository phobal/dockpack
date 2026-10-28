import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkedNpmInstall } from "../dist/dev/dependencies.js";

async function withNpm(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockpack-npm-copy-test-"));
  const cache = path.join(root, "source-cache");
  const bin = path.join(root, "bin");
  const report = path.join(root, "npm-report.json");
  await mkdir(cache); await mkdir(bin);
  await writeFile(path.join(cache, "metadata.json"), '{"vite":"cached"}');
  await writeFile(path.join(bin, "npm"), `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let cache;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cache") cache = args[++i];
  else if (args[i].startsWith("--cache=")) cache = args[i].slice(8);
}
fs.writeFileSync(process.env.NPM_TEST_REPORT, JSON.stringify({ cache, args }));
if (args.includes("--offline") && cache === process.env.NPM_TEST_SOURCE) {
  console.log(JSON.stringify({ error: { code: "ENOTCACHED" } }));
  console.error("npm error ENOTCACHED: metadata lookup needs writable cache");
  process.exit(1);
}
if (!fs.existsSync(path.join(cache, "metadata.json"))) throw Error("cache metadata was not copied");
fs.writeFileSync(path.join(cache, "cache-index-update"), "npm cache write");
if (process.env.NPM_TEST_FAIL === "1") {
  console.error("npm error ENOTCACHED: genuinely missing tarball");
  process.exit(1);
}
console.log(JSON.stringify({ added: 0 }));
`, { mode: 0o755 });
  const run = (args, fail = false) => spawnSync(process.execPath, ["-e", checkedNpmInstall, "--", ...args], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      NPM_TEST_SOURCE: cache, NPM_TEST_REPORT: report, NPM_TEST_FAIL: fail ? "1" : "0",
    },
  });
  try { await action({ root, cache, report, run }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const flag of ["paired", "equals"]) {
  test(`offline npm uses a writable copy for ${flag} cache option and cleans it after success`, () => withNpm(async ({ cache, report, run }) => {
    const result = run(["--offline", ...(flag === "paired" ? ["--cache", cache] : [`--cache=${cache}`]), "--ignore-scripts"]);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(await readFile(report, "utf8"));
    assert.notEqual(actual.cache, cache);
    assert.ok(actual.args.includes("--offline"));
    assert.ok(actual.args.includes("--ignore-scripts"));
    assert.ok(!actual.args.includes("--legacy-peer-deps"));
    assert.ok(!actual.args.includes("--force"));
    assert.equal(existsSync(path.join(cache, "cache-index-update")), false);
    assert.equal(existsSync(actual.cache), false);
    assert.equal(await readFile(path.join(cache, "metadata.json"), "utf8"), '{"vite":"cached"}');
  }));
}

test("genuinely incomplete offline cache still fails and removes the writable copy", () => withNpm(async ({ cache, report, run }) => {
  const result = run(["--offline", "--cache", cache], true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOTCACHED/);
  const actual = JSON.parse(await readFile(report, "utf8"));
  assert.equal(existsSync(actual.cache), false);
  assert.equal(existsSync(path.join(cache, "cache-index-update")), false);
}));

test("online collection writes directly to the bundle cache", () => withNpm(async ({ cache, report, run }) => {
  const result = run(["--cache", cache, "--ignore-scripts"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(report, "utf8")).cache, cache);
  assert.equal(existsSync(path.join(cache, "cache-index-update")), true);
}));
