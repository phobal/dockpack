import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { DockpackError } from "../errors.js";
import { parseBundleManifest, type BundleManifest } from "./manifest.js";

const RESERVED = new Set(["manifest.json", "checksums.sha256"]);

function safeMember(name: string): boolean {
  const normalized = name.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.length > 0 && !normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized)
    && normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function digestFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new DockpackError(`Bundle payload cannot contain symbolic links: ${absolute}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

export async function createArchive(stageDir: string, outputPath: string, initial: BundleManifest): Promise<BundleManifest> {
  const root = path.resolve(stageDir);
  const output = path.resolve(outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  const members = [];
  for (const name of await collectFiles(root)) {
    if (RESERVED.has(name)) throw new DockpackError(`Reserved bundle file exists in staging directory: ${name}`);
    if (!safeMember(name)) throw new DockpackError(`Unsafe bundle member path: ${name}`);
    const content = await digestFile(path.join(root, name));
    members.push({ path: name, ...content });
  }
  const manifest = parseBundleManifest({ ...initial, members });
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await writeFile(path.join(root, "checksums.sha256"), `${members.map((member) => `${member.sha256}  ${member.path}`).join("\n")}\n`, { flag: "wx" });
  const temporaryDir = await mkdtemp(path.join(path.dirname(output), ".dockpack-"));
  const temporaryFile = path.join(temporaryDir, path.basename(output));
  try {
    const archiveFiles = [...members.map((member) => member.path), "manifest.json", "checksums.sha256"];
    await tar.create({ gzip: true, file: temporaryFile, cwd: root, portable: true }, archiveFiles);
    await rename(temporaryFile, output);
    return manifest;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
    await rm(path.join(root, "manifest.json"), { force: true });
    await rm(path.join(root, "checksums.sha256"), { force: true });
  }
}

export async function readManifest(bundlePath: string): Promise<BundleManifest> {
  const directory = await extractArchive(bundlePath);
  try {
    return parseBundleManifest(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
  } catch (error) {
    throw new DockpackError(`Cannot read bundle manifest: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function extractArchive(bundlePath: string, destination?: string): Promise<string> {
  const bundle = path.resolve(bundlePath);
  let bundleStat;
  try {
    bundleStat = await stat(bundle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DockpackError(`Bundle archive not found: ${bundlePath}`);
    throw error;
  }
  if (bundleStat.isDirectory()) {
    throw new DockpackError(`Bundle path is a directory: ${bundlePath}. Expected a Dockpack .tar.gz archive created with 'dockpack pack dev --output <archive.tar.gz>'.`);
  }
  if (!bundleStat.isFile()) throw new DockpackError(`Bundle path is not a regular archive file: ${bundlePath}`);
  const temporary = destination ? path.resolve(destination) : await mkdtemp(path.join(os.tmpdir(), "dockpack-verify-"));
  await mkdir(temporary, { recursive: true });
  const entries: Array<{ path: string; type: string }> = [];
  try {
    await tar.list({ file: bundle, onReadEntry: (entry) => entries.push({ path: entry.path, type: entry.type }) });
    const seen = new Set<string>();
    for (const entry of entries) {
      const name = entry.path;
      if (!safeMember(name)) throw new DockpackError(`Unsafe archive path: ${name}`);
      if (seen.has(name)) throw new DockpackError(`Duplicate archive member: ${name}`);
      if (entry.type !== "File" && entry.type !== "Directory") throw new DockpackError(`Unsupported archive entry type for ${name}: ${entry.type}`);
      seen.add(name);
    }
    await tar.extract({ file: bundle, cwd: temporary, strict: true });
    const manifest = parseBundleManifest(JSON.parse(await readFile(path.join(temporary, "manifest.json"), "utf8")));
    const expected = new Map(manifest.members.map((member) => [member.path, member]));
    for (const entry of entries) {
      const name = entry.path;
      const filePath = path.join(temporary, name);
      const fileStat = await lstat(filePath);
      if (entry.type === "Directory") {
        if (!fileStat.isDirectory()) throw new DockpackError(`Invalid directory archive entry: ${name}`);
        continue;
      }
      if (!fileStat.isFile()) throw new DockpackError(`Non-file bundle member is not allowed: ${name}`);
      if (RESERVED.has(name)) continue;
      const member = expected.get(name);
      if (!member) throw new DockpackError(`Unlisted archive member: ${name}`);
      const actual = await digestFile(filePath);
      if (actual.size !== member.size || actual.sha256 !== member.sha256) throw new DockpackError(`Bundle checksum mismatch: ${name}`);
      expected.delete(name);
    }
    if (expected.size > 0) throw new DockpackError(`Bundle is missing: ${[...expected.keys()].join(", ")}`);
    return temporary;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error instanceof DockpackError) throw error;
    throw new DockpackError(`Cannot verify bundle: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function inspectArchive(bundlePath: string): Promise<BundleManifest> {
  const directory = await extractArchive(bundlePath);
  try {
    const manifest = parseBundleManifest(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
    return manifest;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function bundleFingerprint(bundlePath: string): Promise<string> {
  return (await digestFile(bundlePath)).sha256.slice(0, 16);
}

export function bundleCachePath(fingerprint: string): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "dockpack", "bundles", fingerprint);
}
