import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DockpackError } from "../errors.js";
import { DockerRunner } from "../docker/runner.js";
import type { EcosystemDetection } from "../project/detect.js";

export interface CollectedDependency {
  ecosystem: "python" | "node";
  runtimeImage: string;
  lockDigest: string;
  lockFiles: string[];
}

export async function runtimeImage(detection: EcosystemDetection, projectDir: string): Promise<string> {
  const versionFile = path.join(projectDir, detection.ecosystem === "python" ? ".python-version" : ".nvmrc");
  let hint = detection.runtimeConstraint ?? "";
  try {
    hint = (await readFile(versionFile, "utf8")).trim() || hint;
  } catch {
    // The runtime constraint from the project manifest remains the fallback.
  }
  const match = hint.match(/(\d+)(?:\.(\d+))?/);
  if (!match?.[1]) throw new DockpackError(`Cannot infer a ${detection.ecosystem} version. Add ${detection.ecosystem === "python" ? ".python-version" : ".nvmrc"} or a runtime constraint.`);
  if (detection.ecosystem === "python") {
    if (!match[2]) throw new DockpackError("Python runtime needs a major.minor version such as 3.12.");
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
const { readdirSync, readFileSync } = require("node:fs");
const logDir = "/tmp/dockpack-npm-logs";
const result = spawnSync("npm", ["ci", "--json", "--no-audit", "--no-fund",
  "--update-notifier=false", "--logs-dir=" + logDir, ...process.argv.slice(1)], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
let completed = false;
try {
  const summary = JSON.parse(result.stdout || "");
  completed = Number.isInteger(summary.added) && summary.added >= 0 && !summary.error;
} catch {}
if (result.error || result.status !== 0 || !completed || /^npm\s+(?:error|ERR!)(?:\s|$)/m.test(result.stderr || "")) {
  // npm sometimes hides the network failure behind its own exit-handler error.
  // Logs live outside the cache so this also works with a read-only offline cache.
  try {
    const logs = readdirSync(logDir).filter(name => name.endsWith("-debug-0.log")).sort();
    const log = logs[logs.length - 1];
    if (log) {
      const failures = readFileSync(logDir + "/" + log, "utf8").split(/\r?\n/)
        .filter(line => /http fetch .*failed|\b(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|ENOTCACHED|EAI_AGAIN|EINTEGRITY)\b/.test(line));
      if (failures.length) {
        console.error("dockpack: npm download/cache failure details:");
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
  const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => existsSync(path.join(projectDir, name)));
  if (!requirements) throw new DockpackError("Python dependency collection currently requires requirements.txt or requirements-dev.txt.");
  const wheelhouse = path.join(cacheDir, "python");
  await mkdir(wheelhouse, { recursive: true });
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
      console.log(`[dockpack] ${phase}${offline ? " (network disabled)" : ""}...`);
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
