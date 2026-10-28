import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { runtimeImage } from "../dist/dev/dependencies.js";
import { detectNode } from "../dist/project/detect.js";
import { validateConfig } from "../dist/config/schema.js";
import { initializeProject } from "../dist/commands/init.js";
import { logger } from "../dist/logger.js";
import { DockerRunner } from "../dist/docker/runner.js";
import { createDevelopmentBundle } from "../dist/dev/pack.js";

async function inProject(files, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockpack-node-runtime-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "frontend", scripts: { dev: "vite" } }));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    for (const [name, value] of Object.entries(files)) await writeFile(path.join(root, name), value);
    await action(root, await detectNode(root));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("missing Node version defaults to 22 with actionable configuration instructions", t => inProject({}, async (root, detection) => {
  const warnings = t.mock.method(logger, "warn", () => {});
  assert.equal(await runtimeImage(detection, root), "node:22-bookworm-slim");
  const message = warnings.mock.calls.map(call => call.arguments[0]).join("\n");
  assert.match(message, /22/);
  assert.match(message, /runtime\.node_version/);
  assert.match(message, /\.nvmrc/);
  assert.match(message, /engines\.node/);
}));

test("explicit configuration overrides .nvmrc and preserves the full version", () => inProject({ ".nvmrc": "20" }, async (root, detection) => {
  assert.equal(await runtimeImage(detection, root, { node_version: "22.14.0" }), "node:22.14.0-bookworm-slim");
}));

for (const [filename, value] of [[".nvmrc", "v20.19.0"], [".node-version", "20"], [".tool-versions", "nodejs 20.19.0"]]) {
  test(`auto respects ${filename}`, () => inProject({ [filename]: value }, async (root, detection) => {
    assert.equal(await runtimeImage(detection, root, { node_version: "auto" }), "node:20-bookworm-slim");
  }));
}

test("auto respects package.json engines.node", () => inProject({ "package.json": JSON.stringify({ engines: { node: ">=20" } }) }, async (root, detection) => {
  assert.equal(await runtimeImage(detection, root), "node:20-bookworm-slim");
}));

test("unrecognized explicit project version explains how to configure Node", () => inProject({ ".nvmrc": "invalid" }, async (root, detection) => {
  await assert.rejects(runtimeImage(detection, root), error => /runtime\.node_version/.test(error.message) && /\.nvmrc/.test(error.message) && /engines\.node/.test(error.message));
}));

test("old configs default to automatic Node version selection", () => {
  assert.equal(validateConfig({ project: { name: "frontend" } }).runtime.node_version, "auto");
});

for (const version of ["20", "22.14.0", "v22.14.0", 22]) {
  test(`runtime.node_version accepts ${JSON.stringify(version)}`, () => {
    const config = validateConfig({ project: { name: "frontend" }, runtime: { node_version: version } });
    assert.equal(config.runtime.node_version, String(version));
  });
}

for (const version of ["latest", ">=22", "", -1]) {
  test(`runtime.node_version rejects invalid version ${JSON.stringify(version)}`, () => {
    assert.throws(() => validateConfig({ project: { name: "frontend" }, runtime: { node_version: version } }), /runtime.node_version/);
  });
}

test("init generates a commented runtime setting without overriding project hints", () => inProject({ ".nvmrc": "20" }, async root => {
  const result = await initializeProject(root);
  assert.equal(result.config.runtime.node_version, "auto");
  const yaml = await readFile(path.join(root, ".dockpack.yaml"), "utf8");
  assert.match(yaml, /runtime:/);
  assert.equal(parse(yaml).runtime.node_version, "auto");
  assert.match(yaml, /22/);
  assert.match(yaml, /\.nvmrc/);
}));

for (const configured of [undefined, "20"]) {
  test(`pack dev passes ${configured ?? "default"} runtime selection to Docker`, t => inProject({
    ".dockpack.yaml": `project:\n  name: frontend\n  ecosystems: [node]\n${configured ? `runtime:\n  node_version: "${configured}"\n` : ""}`,
  }, async root => {
    t.mock.method(logger, "warn", () => {});
    t.mock.method(logger, "info", () => {});
    t.mock.method(logger, "success", () => {});
    t.mock.method(logger, "error", () => {});
    t.mock.method(DockerRunner.prototype, "available", () => true);
    t.mock.method(DockerRunner.prototype, "hasImage", () => false);
    t.mock.method(DockerRunner.prototype, "platform", () => ({ id: "linux/amd64" }));
    const stop = new Error("Stop before pulling Docker images");
    const pull = t.mock.method(DockerRunner.prototype, "pull", () => { throw stop; });
    await assert.rejects(createDevelopmentBundle(root), error => error === stop);
    assert.equal(pull.mock.calls[0].arguments[0], `node:${configured ?? "22"}-bookworm-slim`);
  }));
}
