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

export async function collectPython(projectDir: string, cacheDir: string, image: string, docker: DockerRunner): Promise<CollectedDependency> {
  const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => existsSync(path.join(projectDir, name)));
  if (!requirements) throw new DockpackError("Python dependency collection currently requires requirements.txt or requirements-dev.txt.");
  const wheelhouse = path.join(cacheDir, "python");
  await mkdir(wheelhouse, { recursive: true });
  docker.run([
    "run", "--rm", "--platform", docker.platform().id,
    "--mount", `type=bind,source=${mountPath(projectDir)},target=/workspace,readonly`,
    "--mount", `type=bind,source=${mountPath(cacheDir)},target=/cache`,
    "--workdir", "/workspace", image,
    "python", "-m", "pip", "download", "--dest", "/cache/python", "-r", requirements,
  ]);
  return { ecosystem: "python", runtimeImage: image, lockDigest: await sha256Files(projectDir, [requirements]), lockFiles: [requirements] };
}

export async function collectNpm(projectDir: string, cacheDir: string, image: string, docker: DockerRunner): Promise<CollectedDependency> {
  if (!existsSync(path.join(projectDir, "package-lock.json"))) {
    throw new DockpackError("Node.js dependency collection currently requires npm package-lock.json.");
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "dockpack-npm-"));
  const npmCache = path.join(cacheDir, "npm");
  await mkdir(npmCache, { recursive: true });
  try {
    await copyFile(path.join(projectDir, "package.json"), path.join(scratch, "package.json"));
    await copyFile(path.join(projectDir, "package-lock.json"), path.join(scratch, "package-lock.json"));
    docker.run([
      "run", "--rm", "--platform", docker.platform().id,
      "--mount", `type=bind,source=${mountPath(scratch)},target=/manifest,readonly`,
      "--mount", `type=bind,source=${mountPath(npmCache)},target=/cache`,
      "--workdir", "/manifest", image, "npm", "ci", "--cache", "/cache", "--ignore-scripts",
    ]);
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
