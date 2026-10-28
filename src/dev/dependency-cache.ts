import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DockerRunner } from "../docker/runner.js";
import { DockpackError } from "../errors.js";
import { logger } from "../logger.js";
import { VERSION } from "../version.js";
import { collectNpm, collectPython, sha256Files, type CollectedDependency } from "./dependencies.js";
import { pythonDependencyFiles } from "./python.js";

type Ecosystem = "node" | "python";

async function dependencyInputs(root: string, ecosystem: Ecosystem): Promise<string[] | undefined> {
  if (ecosystem === "node") {
    return ["package.json", "package-lock.json", ...(existsSync(path.join(root, ".npmrc")) ? [".npmrc"] : [])];
  }
  const files = pythonDependencyFiles(root);
  if (files.includes("uv.lock")) return files;
  const inputs = new Set<string>();
  async function requirements(file: string): Promise<boolean> {
    const relative = path.relative(root, path.resolve(root, file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    if (inputs.has(relative)) return true;
    inputs.add(relative);
    const text = await readFile(path.join(root, relative), "utf8");
    for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith("#")) continue;
      const include = entry.match(/^(?:-r\s*|-c\s*|--requirement(?:=|\s+)|--constraint(?:=|\s+))([^\s#]+)\s*(?:#.*)?$/);
      if (include) {
        const reference = include[1]!.replace(/^(['"])(.*)\1$/, "$2");
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) return false;
        if (!await requirements(path.resolve(root, path.dirname(relative), reference))) return false;
      // Local packages and environment-dependent requirements need fresh collection.
      } else if ((entry.startsWith("-") && !entry.startsWith("--hash=")) || /\$\{|(?:^|\s)(?:\.{1,2}\/|\/|file:)|^-e\b|^--editable\b/.test(entry)
        || (!entry.startsWith("-") && !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]]+\])?(?:\s*(?:[<>=!~;]|$))/.test(entry))) return false;
    }
    return true;
  }
  return await requirements(files[0]!) ? [...inputs] : undefined;
}

/** Hash actual artifacts so incomplete or altered downloads cannot become cache hits. */
async function payloadDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      hash.update(path.relative(root, absolute)).update("\0");
      if (entry.isDirectory()) { hash.update("directory\0"); await walk(absolute); }
      else if (entry.isFile()) {
        hash.update("file\0");
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        hash.update("\0");
      } else throw new DockpackError("Dependency cache cannot contain symbolic links or special files.");
    }
  }
  await walk(root);
  return hash.digest("hex");
}

export async function collectDependencies(
  project: string, destination: string, image: string, docker: DockerRunner,
  platform: string, ecosystem: Ecosystem, refresh = false,
): Promise<CollectedDependency> {
  const collect = (cache: string) => ecosystem === "node"
    ? collectNpm(project, cache, image, docker, platform)
    : collectPython(project, cache, image, docker, platform);
  const inputs = await dependencyInputs(project, ecosystem);
  if (!inputs) {
    logger.info(`[dockpack] ${ecosystem} dependency inputs include local or dynamic sources; collecting without persistent reuse.`);
    return collect(destination);
  }
  const inputDigest = await sha256Files(project, inputs);
  const lockFiles = ecosystem === "node" ? ["package-lock.json"] : pythonDependencyFiles(project);
  const lockDigest = await sha256Files(project, lockFiles);
  const key = createHash("sha256").update(JSON.stringify({
    format: 1, version: VERSION, ecosystem, platform, image, imageId: docker.imageId(image), inputDigest,
  })).digest("hex");
  const base = path.join(project, ".dockpack", "cache", "dependencies");
  const entry = path.join(base, key);
  const payload = path.join(entry, "payload");
  if (!refresh && existsSync(entry)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(entry, "metadata.json"), "utf8")) as {
        key: string; digest: string; result: CollectedDependency;
      };
      if (metadata.key !== key || metadata.result.ecosystem !== ecosystem
        || metadata.result.runtimeImage !== image || metadata.result.lockDigest !== lockDigest
        || JSON.stringify(metadata.result.lockFiles) !== JSON.stringify(lockFiles)
        || metadata.digest !== await payloadDigest(payload)) throw new Error("cache integrity check failed");
      await mkdir(destination, { recursive: true });
      await cp(payload, destination, { recursive: true });
      logger.info(`[dockpack] Reusing verified ${ecosystem} dependency cache (${platform}, ${image}); skipping download and installation validation.`);
      return metadata.result;
    } catch (error) {
      logger.warn(`[dockpack] Cannot reuse ${ecosystem} dependency cache; collecting again: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logger.info(`[dockpack] ${refresh ? "Refreshing" : "Preparing"} ${ecosystem} dependency cache (${platform}, ${image})...`);
  await mkdir(base, { recursive: true });
  const pending = await mkdtemp(path.join(base, ".pending-"));
  try {
    const fresh = path.join(pending, "payload");
    await mkdir(fresh);
    const result = await collect(fresh);
    if (inputDigest !== await sha256Files(project, inputs)) {
      throw new DockpackError("Dependency inputs changed during collection; retry with unchanged dependency files.");
    }
    await writeFile(path.join(pending, "metadata.json"), JSON.stringify({ key, result, digest: await payloadDigest(fresh) }));
    // Publish only after collection and offline validation succeed. A failure keeps the old entry.
    await rm(entry, { recursive: true, force: true });
    try { await rename(pending, entry); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Another pack published the same key; use our independently validated payload.
      await mkdir(destination, { recursive: true });
      await cp(fresh, destination, { recursive: true });
      return result;
    }
    await mkdir(destination, { recursive: true });
    await cp(payload, destination, { recursive: true });
    return result;
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}
