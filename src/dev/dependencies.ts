import { logger } from "../logger.js";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DockpackError } from "../errors.js";
import { DockerRunner } from "../docker/runner.js";
import type { EcosystemDetection } from "../project/detect.js";
import type { DockpackConfig } from "../config/schema.js";
import { pythonDependencyFiles, validateUvProject, portableUvRequirements, UV_REQUIREMENTS, UV_EXPORT_SCRIPT, PYTHON_OFFLINE_CHECK } from "./python.js";

export type RuntimeVersions = Partial<DockpackConfig["runtime"]>;

export interface CollectedDependency {
  ecosystem: "python" | "node";
  runtimeImage: string;
  lockDigest: string;
  lockFiles: string[];
}

const DEFAULT_NODE_VERSION = "22";
const DEFAULT_PYTHON_VERSION = "3.12";
const PYTHON_VERSION_GUIDANCE = '可在项目根目录的 .dockpack.yaml 中设置 runtime.python_version，例如：\n' +
  'runtime:\n  python_version: "3.12"\n' +
  '版本必须加引号。也可在 .python-version 中填写 3.12，或在 pyproject.toml 的 [project] 中设置 requires-python = ">=3.12"。\n' +
  '优先级：runtime.python_version 显式版本 > 项目版本声明 > 默认 Python 3.12。修改后请重新执行 dockpack pack dev。';
const NODE_VERSION_GUIDANCE = '可在项目根目录的 .dockpack.yaml 中设置 runtime.node_version，例如：\n' +
  'runtime:\n  node_version: "22"\n' +
  '也可在 .nvmrc 中填写 22，或在 package.json 中设置 "engines": { "node": ">=22" }（engines.node）。\n' +
  '优先级：runtime.node_version 显式版本 > 项目版本声明 > 默认 Node.js 22。修改后请重新执行 dockpack pack dev。';

export async function runtimeImage(detection: EcosystemDetection, projectDir: string, runtime: RuntimeVersions = {}): Promise<string> {
  const nodeVersion = runtime.node_version ?? "auto";
  const pythonVersion = runtime.python_version ?? "auto";
  if (detection.ecosystem === "node" && nodeVersion !== "auto") {
    return `node:${nodeVersion.replace(/^v/, "")}-bookworm-slim`;
  }
  if (detection.ecosystem === "python" && pythonVersion !== "auto") {
    return `python:${pythonVersion}-slim`;
  }
  const versionFile = path.join(projectDir, detection.ecosystem === "python" ? ".python-version" : ".nvmrc");
  let hint = detection.runtimeConstraint ?? "";
  try {
    hint = (await readFile(versionFile, "utf8")).trim() || hint;
  } catch {
    // The runtime constraint from the project manifest remains the fallback.
  }
  if (detection.ecosystem === "node" && !hint.trim()) {
    logger.warn(`[dockpack] 未指定 Node.js 版本，将使用默认 Node.js ${DEFAULT_NODE_VERSION}（node:${DEFAULT_NODE_VERSION}-bookworm-slim）。\n${NODE_VERSION_GUIDANCE}`);
    return `node:${DEFAULT_NODE_VERSION}-bookworm-slim`;
  }
  if (detection.ecosystem === "python" && !hint.trim()) {
    logger.warn(`[dockpack] 未指定 Python 版本，将使用默认 Python ${DEFAULT_PYTHON_VERSION}（python:${DEFAULT_PYTHON_VERSION}-slim）。\n${PYTHON_VERSION_GUIDANCE}`);
    return `python:${DEFAULT_PYTHON_VERSION}-slim`;
  }
  const match = hint.match(/(\d+)(?:\.(\d+))?/);
  if (!match?.[1]) {
    if (detection.ecosystem === "node") throw new DockpackError(`Cannot infer a Node.js version from '${hint}'.\n${NODE_VERSION_GUIDANCE}`);
    throw new DockpackError(`Cannot infer a Python version from '${hint}'.\n${PYTHON_VERSION_GUIDANCE}`);
  }
  if (detection.ecosystem === "python") {
    if (!match[2]) throw new DockpackError(`Python runtime needs a major.minor version such as 3.12; received '${hint}'.\n${PYTHON_VERSION_GUIDANCE}`);
    return `python:${match[1]}.${match[2]}-slim`;
  }
  return `node:${match[1]}-bookworm-slim`;
}

export async function sha256Files(root: string, filenames: string[]): Promise<string> {
  const crypto = await import("node:crypto");
  const hash = crypto.createHash("sha256");
  for (const filename of [...filenames].sort()) {
    hash.update(filename);
    hash.update("\0");
    hash.update(await readFile(path.join(root, filename)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function mountPath(hostPath: string): string {
  const absolute = path.resolve(hostPath);
  if (absolute.includes(",")) throw new DockpackError(`Docker bind mount paths containing commas are not supported: ${absolute}`);
  return absolute;
}

// Some npm versions report fatal errors (including "Exit handler never called!")
// with status 0. Require an actual npm ci completion summary as well as status.
export const checkedNpmInstall = String.raw`
const { spawnSync } = require("node:child_process");
const { constants, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const logDir = "/tmp/dockpack-npm-logs";
const args = process.argv.slice(1);
let temporaryCache;
let result;
try {
  if (args.includes("--offline")) {
    let cacheIndex = -1;
    let sourceCache;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--cache") { cacheIndex = i; sourceCache = args[++i]; }
      else if (args[i].startsWith("--cache=")) { cacheIndex = i; sourceCache = args[i].slice(8); }
    }
    if (sourceCache) {
      // npm can update its index even on cache reads; a read-only cache may
      // misleadingly report ENOTCACHED despite already containing the metadata.
      temporaryCache = mkdtempSync(path.join(os.tmpdir(), "dockpack-npm-cache-"));
      cpSync(sourceCache, temporaryCache, { recursive: true, mode: constants.COPYFILE_FICLONE });
      if (args[cacheIndex] === "--cache") args[cacheIndex + 1] = temporaryCache;
      else args[cacheIndex] = "--cache=" + temporaryCache;
    }
  }
  result = spawnSync("npm", ["ci", "--json", "--no-audit", "--no-fund",
    "--update-notifier=false", "--logs-dir=" + logDir, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  result = { error, status: 1 };
} finally {
  if (temporaryCache) rmSync(temporaryCache, { recursive: true, force: true });
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
let completed = false;
// Lifecycle scripts can write to stdout even with --json. Parse the trailing
// npm JSON document even when script output has no trailing newline.
// Keep script output visible and still require a real completion summary.
const output = result.stdout || "";
const starts = [...output.matchAll(/\{/g)].map(match => match.index);
for (const start of starts.reverse()) {
  try {
    const summary = JSON.parse(output.slice(start));
    completed = Number.isInteger(summary.added) && summary.added >= 0 && !summary.error;
    break;
  } catch {}
}
if (result.error || result.status !== 0 || !completed || /^npm\s+(?:error|ERR!)(?:\s|$)/m.test(result.stderr || "")) {
  console.error("dockpack: npm install diagnostics: exit=" + result.status + "; signal=" + (result.signal || "none") + "; completion_summary=" + completed + "; node=" + process.version);
  // npm sometimes hides the network failure behind its own exit-handler error.
  // Logs live outside the cache so this also works with a read-only offline cache.
  try {
    const logs = readdirSync(logDir).filter(name => name.endsWith("-debug-0.log")).sort();
    const log = logs[logs.length - 1];
    if (log) {
      const failures = readFileSync(logDir + "/" + log, "utf8").split(/\r?\n/)
        .filter(line => /http fetch .*failed|\b(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|ENOTCACHED|EAI_AGAIN|EINTEGRITY)\b|^\d+ (?:error|verbose (?:stack|exit|code)|info run)\b/.test(line));
      if (failures.length) {
        console.error("dockpack: npm failure details:");
        for (const line of failures.slice(-20)) console.error(line);
      }
    }
  } catch {}
  console.error("dockpack: npm ci did not complete successfully; refusing to use an incomplete dependency cache.");
  if (result.error) console.error(result.error.message);
  process.exit(1);
}
`;

export async function collectPython(projectDir: string, cacheDir: string, image: string, docker: DockerRunner, platform: string): Promise<CollectedDependency> {
  const files = pythonDependencyFiles(projectDir);
  const wheelhouse = path.join(cacheDir, "python");
  await mkdir(wheelhouse, { recursive: true });
  if (files.includes("uv.lock")) {
    validateUvProject(projectDir);
    const args = ["run", "--rm", "--pull", "never", "--platform", platform,
      "--mount", `type=bind,source=${mountPath(projectDir)},target=/workspace,readonly`,
      "--mount", `type=bind,source=${mountPath(cacheDir)},target=/cache`,
      "--workdir", "/workspace", image];
    const before = await sha256Files(projectDir, files);
    try {
      logger.info("[dockpack] Exporting uv.lock with --locked (including default development groups)...");
      docker.run([...args, "python", "-c", UV_EXPORT_SCRIPT], { streamOutput: true });
      const filename = path.join(cacheDir, UV_REQUIREMENTS);
      const requirements = await readFile(filename, "utf8");
      const portable = portableUvRequirements(requirements);
      docker.run([...args, "python", "-m", "pip", "download", "--only-binary=:all:", "--require-hashes", "--dest", "/cache/python", "-r", `/cache/${UV_REQUIREMENTS}`], { streamOutput: true });
      await writeFile(filename, portable, "utf8");
      logger.info("[dockpack] Validating uv dependencies with network disabled...");
      docker.run(["run", "--rm", "--pull", "never", "--network", "none", "--platform", platform,
        "--mount", `type=bind,source=${mountPath(cacheDir)},target=/cache,readonly`,
        image, "python", "-c", PYTHON_OFFLINE_CHECK], { streamOutput: true });
      if (await sha256Files(projectDir, files) !== before) throw new DockpackError("Python dependency inputs changed while packaging; retry with unchanged pyproject.toml and uv.lock.");
      return { ecosystem: "python", runtimeImage: image, lockDigest: before, lockFiles: files };
    } catch (error) {
      throw new DockpackError(`uv dependency collection failed. Run 'uv lock' on a connected machine and retry 'dockpack pack dev'. Dependencies need wheels for ${platform} and ${image}; Git/path dependencies and source-only packages are not supported. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const requirements = files[0]!;
  docker.run([
    "run", "--rm", "--platform", platform,
    "--mount", `type=bind,source=${mountPath(projectDir)},target=/workspace,readonly`,
    "--mount", `type=bind,source=${mountPath(cacheDir)},target=/cache`,
    "--workdir", "/workspace", image,
    "python", "-m", "pip", "download", "--dest", "/cache/python", "-r", requirements,
  ], { streamOutput: true });
  return { ecosystem: "python", runtimeImage: image, lockDigest: await sha256Files(projectDir, [requirements]), lockFiles: [requirements] };
}

export async function collectNpm(projectDir: string, cacheDir: string, image: string, docker: DockerRunner, platform: string): Promise<CollectedDependency> {
  if (!existsSync(path.join(projectDir, "package-lock.json"))) {
    throw new DockpackError("Node.js dependency collection currently requires npm package-lock.json.");
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "dockpack-npm-"));
  const npmCache = path.join(cacheDir, "npm");
  await mkdir(npmCache, { recursive: true });
  try {
    for (const offline of [false, true]) {
      // A fresh directory ensures validation cannot reuse the online installation.
      const manifests = path.join(scratch, offline ? "offline" : "online");
      await mkdir(manifests);
      await copyFile(path.join(projectDir, "package.json"), path.join(manifests, "package.json"));
      await copyFile(path.join(projectDir, "package-lock.json"), path.join(manifests, "package-lock.json"));
      const phase = offline ? "Offline npm cache validation" : "Online npm dependency collection";
      logger.info(`[dockpack] ${phase}${offline ? " (network disabled)" : ""}...`);
      try {
        docker.run([
          "run", "--rm", "--pull", "never", "--platform", platform,
          ...(offline ? ["--network", "none"] : []),
          "--mount", `type=bind,source=${mountPath(manifests)},target=/manifest`,
          "--mount", `type=bind,source=${mountPath(npmCache)},target=/cache${offline ? ",readonly" : ""}`,
          "--workdir", "/manifest", image, "node", "-e", checkedNpmInstall, "--",
          "--cache", "/cache", "--ignore-scripts",
          ...(offline ? ["--offline"] : []),
        ], { streamOutput: true });
      } catch (error) {
        throw new DockpackError(
          `${phase} failed. No new development bundle was created. ` +
          "Check the npm errors above and registry access on the connected machine, then run 'dockpack pack dev' again.",
          { cause: error },
        );
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return {
    ecosystem: "node",
    runtimeImage: image,
    lockDigest: await sha256Files(projectDir, ["package-lock.json"]),
    lockFiles: ["package-lock.json"],
  };
}
