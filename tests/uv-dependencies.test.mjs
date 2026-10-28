import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectPython, sha256Files } from "../dist/dev/dependencies.js";
import { detectPython } from "../dist/project/detect.js";
import { createDevelopmentBundle } from "../dist/dev/pack.js";
import { DockerRunner } from "../dist/docker/runner.js";
import { logger } from "../dist/logger.js";

const pyproject = '[project]\nname = "backend"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["idna==3.10"]\n';
const lock = 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n[[package]]\nname = "backend"\nversion = "0.1.0"\nsource = { virtual = "." }\n[[package]]\nname = "idna"\nversion = "3.10"\nsource = { registry = "https://pypi.org/simple" }\n';
const exported = 'idna==3.10 \\\n    --hash=sha256:' + 'a'.repeat(64) + '\n';

async function project(files, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockpack-uv-"));
  try {
    await writeFile(path.join(root, "pyproject.toml"), pyproject);
    await writeFile(path.join(root, "uv.lock"), lock);
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
    const cache = path.join(root, "cache");
    await mkdir(cache);
    await action(root, cache);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("uv.lock remains authoritative when requirements.txt also exists", () => project({ "requirements.txt": "outdated==1\n" }, async root => {
  const detection = await detectPython(root);
  assert.equal(detection.packageManager, "uv");
  assert.ok(detection.findings.some(message => /requirements.*ignored/i.test(message)));
}));

test("pack dev accepts uv projects and reaches runtime image collection", t => project({ ".dockpack.yaml": 'project:\n  name: backend\n  ecosystems: [python]\nruntime:\n  python_version: "3.12"\n' }, async root => {
  for (const method of ["warn", "info", "error", "success"]) t.mock.method(logger, method, () => {});
  t.mock.method(DockerRunner.prototype, "available", () => true);
  t.mock.method(DockerRunner.prototype, "platform", () => ({ id: "linux/amd64" }));
  const stop = new Error("runtime collection reached");
  t.mock.method(DockerRunner.prototype, "pull", () => { throw stop; });
  await assert.rejects(createDevelopmentBundle(root), error => error === stop);
}));

test("collectPython exports locked requirements, downloads wheels and validates installation without network", () => project({}, async (root, cache) => {
  const calls = [];
  const docker = { run(args) {
    calls.push(args);
    if (args.some(value => value.includes("uv") && value.includes("export"))) writeFileSync(path.join(cache, "python-requirements.txt"), exported);
    return "";
  } };
  const result = await collectPython(root, cache, "python:3.12-slim", docker, "linux/amd64");
  assert.deepEqual(result.lockFiles, ["pyproject.toml", "uv.lock"]);
  assert.equal(result.lockDigest, await sha256Files(root, result.lockFiles));
  const commands = calls.map(args => args.join(" "));
  assert.ok(commands.some(command => command.includes("--locked") && command.includes("--no-emit-project")));
  assert.ok(commands.some(command => command.includes("pip download") && command.includes("--only-binary=:all:") && command.includes("--require-hashes")));
  assert.ok(commands.some(command => command.includes("--network none") && command.includes("--no-index")));
  assert.equal(await readFile(path.join(cache, "python-requirements.txt"), "utf8"), exported);
  assert.equal(await readFile(path.join(root, "uv.lock"), "utf8"), lock);
}));

test("uv export failures abort packaging without falling back to requirements.txt", () => project({ "requirements.txt": "idna\n" }, async (root, cache) => {
  const docker = { run() { throw new Error("lockfile is out of date"); } };
  await assert.rejects(collectPython(root, cache, "python:3.12-slim", docker, "linux/amd64"), /uv|lockfile/);
}));

test("uv digest tracks both pyproject.toml and uv.lock plus optional uv.toml", () => project({ "uv.toml": 'index-strategy = "first-index"\n' }, async root => {
  const { pythonDependencyFiles } = await import("../dist/dev/python.js");
  const files = pythonDependencyFiles(root);
  assert.deepEqual(files, ["pyproject.toml", "uv.lock", "uv.toml"]);
  const original = await sha256Files(root, files);
  await writeFile(path.join(root, "pyproject.toml"), pyproject + '\n[dependency-groups]\ndev = ["pytest"]\n');
  assert.notEqual(await sha256Files(root, files), original);
  await writeFile(path.join(root, "pyproject.toml"), pyproject);
  await writeFile(path.join(root, "uv.lock"), lock + "\n# updated\n");
  assert.notEqual(await sha256Files(root, files), original);
}));

test("uv offline installation uses the bundled export rather than any stale requirements.txt", () => project({ "requirements.txt": "outdated==1\n" }, async (root, cache) => {
  const { pythonRequirementsPath } = await import("../dist/dev/python.js");
  await writeFile(path.join(cache, "python-requirements.txt"), exported);
  assert.equal(pythonRequirementsPath(root, cache), path.join(cache, "python-requirements.txt"));
  await rm(path.join(cache, "python-requirements.txt"));
  assert.throws(() => pythonRequirementsPath(root, cache), /Recreate|repack/i);
}));

for (const source of ['{ git = "https://example.com/repo", rev = "abc" }', '{ directory = "../local" }']) {
  test(`rejects nonportable uv dependency ${source}`, () => project({ "uv.lock": lock.replace('{ registry = "https://pypi.org/simple" }', source) }, async (root, cache) => {
    const docker = { run() { throw new Error("must reject before running Docker"); } };
    await assert.rejects(collectPython(root, cache, "python:3.12-slim", docker, "linux/amd64"), /Git|local|path|registry/i);
  }));
}

test("pip requirements projects keep their existing input and install paths", () => project({ "requirements.txt": "idna==3.10\n" }, async (root, cache) => {
  await rm(path.join(root, "uv.lock"));
  const { pythonDependencyFiles, pythonRequirementsPath } = await import("../dist/dev/python.js");
  assert.deepEqual(pythonDependencyFiles(root), ["requirements.txt"]);
  assert.equal(pythonRequirementsPath(root, cache), path.join(root, "requirements.txt"));
}));

async function uvBundle(root) {
  const { createArchive } = await import("../dist/bundles/archive.js");
  const { makeManifest } = await import("../dist/bundles/manifest.js");
  const stage = path.join(root, "stage");
  await mkdir(path.join(stage, "cache"), { recursive: true });
  await mkdir(path.join(stage, "images"), { recursive: true });
  await writeFile(path.join(stage, "cache", "python-requirements.txt"), exported);
  await writeFile(path.join(stage, "images", "images.tar"), "docker image fixture");
  const archive = path.join(root, "development.tar.gz");
  await createArchive(stage, archive, makeManifest({
    bundle_kind: "dev", dockpack_version: "0.7.0", project_name: "backend", target_platform: "linux/amd64",
    images: ["python:3.12-slim"], services: [], dependencies: { python: await sha256Files(root, ["pyproject.toml", "uv.lock"]) },
  }));
  await writeFile(path.join(root, ".dockpack.yaml"), 'project:\n  name: backend\n  ecosystems: [python]\nruntime:\n  python_version: "3.12"\napplication:\n  command: [python, main.py]\n');
  return archive;
}

function mockDocker(t) {
  for (const method of ["warn", "info", "error", "success"]) t.mock.method(logger, method, () => {});
  t.mock.method(DockerRunner.prototype, "available", () => true);
  t.mock.method(DockerRunner.prototype, "platform", () => ({ id: "linux/amd64", os: "linux" }));
  t.mock.method(DockerRunner.prototype, "load", () => {});
  t.mock.method(DockerRunner.prototype, "hasImage", () => true);
  t.mock.method(DockerRunner.prototype, "imagePlatform", () => "linux/amd64");
}

test("dev init and rebuild install the cached uv export and detect lock changes", t => project({}, async root => {
  const childProcess = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { initializeDevProject, rebuildDev } = await import("../dist/dev/project.js");
  const archive = await uvBundle(root);
  mockDocker(t);
  const commands = [];
  t.mock.method(childProcess, "spawnSync", (_command, args) => {
    commands.push(args);
    return { status: 0, stdout: args.includes("version") ? "Docker Compose version v2.24.4" : "", stderr: "" };
  });
  syncBuiltinESMExports();
  const oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(root, "xdg-cache");
  try {
    await initializeDevProject(root, archive);
    await rebuildDev(root);
    const installs = commands.filter(args => args.includes("install"));
    assert.equal(installs.length, 2);
    for (const args of installs) {
      assert.ok(args.includes("--no-index"));
      assert.ok(args.includes("/dockpack-cache/python-requirements.txt"));
      assert.ok(!args.includes("/workspace/requirements.txt"));
    }
    const state = JSON.parse(await readFile(path.join(root, ".dockpack", "state.json"), "utf8"));
    assert.equal(state.dependencies.python, await sha256Files(root, ["pyproject.toml", "uv.lock"]));
    await writeFile(path.join(root, "uv.lock"), lock + "\n# changed\n");
    await assert.rejects(rebuildDev(root), /differ|changed/i);
  } finally {
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCache;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}));

test("generated Python production Dockerfile installs the uv bundle export", t => project({}, async root => {
  const { buildProductionBundle } = await import("../dist/prod/build.js");
  const archive = await uvBundle(root);
  await writeFile(path.join(root, "main.py"), "print('hello')\n");
  mockDocker(t);
  t.mock.method(DockerRunner.prototype, "buildEnvironment", () => ({ BUILDX_BUILDER: "default" }));
  const stop = new Error("production Dockerfile inspected");
  t.mock.method(DockerRunner.prototype, "run", args => {
    assert.equal(args[0], "buildx");
    const context = args.at(-1);
    const file = args[args.indexOf("--file") + 1];
    // DockerRunner is synchronous, as are these fixture checks.
    const content = readFileSync(file, "utf8");
    assert.match(content, /COPY python-requirements.txt .\/requirements.txt/);
    assert.match(content, /RUN --network=none python -m pip install --no-index/);
    assert.equal(readFileSync(path.join(context, "python-requirements.txt"), "utf8"), exported);
    throw stop;
  });
  await assert.rejects(buildProductionBundle(root, path.join(root, "prod.tar.gz"), archive), error => error === stop);
}));

test("portable export retains hashes and markers but removes private index URLs", async () => {
  const { portableUvRequirements } = await import("../dist/dev/python.js");
  const requirements = '--index-url https://private.example/simple\n--extra-index-url https://other.example/simple\n' + exported;
  assert.equal(portableUvRequirements(requirements), exported);
  const marked = 'idna==3.10 ; python_version >= "3.9" \\\n    --hash=sha256:' + 'a'.repeat(64) + '\n';
  assert.equal(portableUvRequirements(marked), marked);
  for (const unsupported of ['-e .', 'idna @ https://example.com/idna.whl', 'idna>=3.10']) {
    assert.throws(() => portableUvRequirements(unsupported), /offline|unpinned/i);
  }
});

test("uv.lock without pyproject.toml reports the missing project metadata", () => project({}, async (root, cache) => {
  await rm(path.join(root, "pyproject.toml"));
  await assert.rejects(collectPython(root, cache, "python:3.12-slim", {}, "linux/amd64"), /pyproject.toml/);
}));

test("uv workspaces fail clearly instead of dropping local member packages", () => project({
  "pyproject.toml": pyproject + '\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
}, async (root, cache) => {
  await assert.rejects(collectPython(root, cache, "python:3.12-slim", {}, "linux/amd64"), /workspace/i);
}));
