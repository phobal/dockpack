import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dependencyNotices } from "../scripts/dependency-notices.mjs";

async function withPackage(licenseFiles, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockpack-notices-"));
  const directory = path.join(root, "node_modules", "example");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
  for (const [name, text] of Object.entries(licenseFiles)) await writeFile(path.join(directory, name), text);
  try { await action(root, { "node_modules/example/index.js": {} }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const filename of ["LICENSE", "LICENSE.md", "LICENSE-MIT.txt", "LICENSE_MIT", "COPYING-ISC", "NOTICE.txt"]) {
  test(`includes full license text from ${filename}`, () => withPackage({ [filename]: "Copyright example\nFull license terms" }, async (root, inputs) => {
    assert.equal(await dependencyNotices(inputs, root), "example@1.0.0\nCopyright example\nFull license terms");
  }));
}

test("includes all license notices once per bundled package", () => withPackage({ "LICENSE-MIT.txt": "MIT terms", "NOTICE": "Attribution" }, async (root, inputs) => {
  inputs["node_modules/example/another.js"] = {};
  assert.equal(await dependencyNotices(inputs, root), "example@1.0.0\nMIT terms\nAttribution");
}));

test("still rejects packages without license text", () => withPackage({ "README.md": "See our website", "LICENSES.md": "Unrelated file" }, async (root, inputs) => {
  await assert.rejects(dependencyNotices(inputs, root), /Missing license text for bundled dependency: example/);
}));
