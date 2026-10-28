import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { runtimeImage } from "../dist/dev/dependencies.js";
import { detectPython } from "../dist/project/detect.js";
import { validateConfig } from "../dist/config/schema.js";
import { initializeProject } from "../dist/commands/init.js";
import { logger } from "../dist/logger.js";
import { DockerRunner } from "../dist/docker/runner.js";
import { createDevelopmentBundle } from "../dist/dev/pack.js";

async function inProject(files, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockpack-python-runtime-"));
  try {
    await writeFile(path.join(root, "requirements.txt"), "");
    for (const [name, value] of Object.entries(files)) await writeFile(path.join(root, name), value);
    await action(root, await detectPython(root));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("missing Python version defaults to 3.12 with configuration instructions", t => inProject({}, async (root, detection) => {
  const warnings = t.mock.method(logger, "warn", () => {});
  assert.equal(await runtimeImage(detection, root), "python:3.12-slim");
  const message = warnings.mock.calls.map(call => call.arguments[0]).join("\n");
  for (const value of ["3.12", "runtime.python_version", ".python-version", "requires-python", "pyproject.toml"]) assert.ok(message.includes(value), value);
}));

test("configured Python version overrides .python-version and preserves patch version", () => inProject({ ".python-version": "3.11" }, async (root, detection) => {
  assert.equal(await runtimeImage(detection, root, { python_version: "3.12.7", node_version: "20" }), "python:3.12.7-slim");
}));

for (const [filename, value] of [[".python-version", "3.11.9"], ["pyproject.toml", '[project]\nrequires-python = ">=3.11"']]) {
  test(`auto respects ${filename}`, () => inProject({ [filename]: value }, async (root, detection) => {
    assert.equal(await runtimeImage(detection, root), "python:3.11-slim");
  }));
}

for (const value of ["invalid", "3"]) {
  test(`invalid project version ${value} explains Python configuration`, () => inProject({ ".python-version": value }, async (root, detection) => {
    await assert.rejects(runtimeImage(detection, root), error => /runtime\.python_version/.test(error.message) && /\.python-version/.test(error.message) && /requires-python/.test(error.message));
  }));
}

test("old configs default to automatic Python version selection", () => {
  assert.equal(validateConfig({ project: { name: "backend" } }).runtime.python_version, "auto");
});

for (const version of ["3.11", "3.12.7", "auto"]) {
  test(`runtime.python_version accepts ${version}`, () => {
    assert.equal(validateConfig({ project: { name: "backend" }, runtime: { python_version: version } }).runtime.python_version, version);
  });
}

for (const version of [3.12, "3", "latest", ">=3.12", ""]) {
  test(`runtime.python_version rejects ${JSON.stringify(version)}`, () => {
    assert.throws(() => validateConfig({ project: { name: "backend" }, runtime: { python_version: version } }), /runtime.python_version/);
  });
}

test("init generates a commented automatic Python version setting", () => inProject({}, async root => {
  const result = await initializeProject(root);
  assert.equal(result.config.runtime.python_version, "auto");
  const yaml = await readFile(path.join(root, ".dockpack.yaml"), "utf8");
  assert.equal(parse(yaml).runtime.python_version, "auto");
  assert.match(yaml, /\.python-version/);
  assert.match(yaml, /3\.12/);
}));

for (const configured of [undefined, "3.11"]) {
  test(`pack dev passes ${configured ?? "default"} Python version to Docker`, t => inProject({
    ".dockpack.yaml": `project:\n  name: backend\n  ecosystems: [python]\n${configured ? `runtime:\n  python_version: "${configured}"\n` : ""}`,
  }, async root => {
    for (const method of ["warn", "info", "error", "success"]) t.mock.method(logger, method, () => {});
    t.mock.method(DockerRunner.prototype, "available", () => true);
    t.mock.method(DockerRunner.prototype, "hasImage", () => false);
    t.mock.method(DockerRunner.prototype, "platform", () => ({ id: "linux/amd64" }));
    const stop = new Error("Stop before pulling Docker images");
    const pull = t.mock.method(DockerRunner.prototype, "pull", () => { throw stop; });
    await assert.rejects(createDevelopmentBundle(root), error => error === stop);
    assert.equal(pull.mock.calls[0].arguments[0], `python:${configured ?? "3.12"}-slim`);
  }));
}
