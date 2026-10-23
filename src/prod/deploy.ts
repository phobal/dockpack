import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync as readTextSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import * as tar from "tar";
import { bundleFingerprint, extractArchive, inspectArchive } from "../bundles/archive.js";
import type { BundleManifest } from "../bundles/manifest.js";
import { DockerRunner } from "../docker/runner.js";
import { getComposeCommand, runCompose } from "../compose/command.js";
import { DockpackError } from "../errors.js";
import { readProductionImageIds } from "./images.js";

interface Deployment {
  root: string;
  composeFile: string;
  manifest: BundleManifest;
  projectName: string;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 36) || "project";
}

async function loadDeployment(bundlePath: string, importImages: boolean, activateImages = false): Promise<Deployment> {
  const fingerprint = await bundleFingerprint(bundlePath);
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const destination = path.join(base, "dockpack", "deployments", fingerprint);
  await mkdir(path.dirname(destination), { recursive: true });
  let root = destination;
  let manifest: BundleManifest;
  if (existsSync(path.join(destination, "manifest.json"))) {
    manifest = await inspectArchive(bundlePath);
  } else {
    root = await extractArchive(bundlePath, destination);
    manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as BundleManifest;
  }
  if (manifest.bundle_kind !== "prod") throw new DockpackError("Expected a production bundle.");
  const composeFile = path.join(root, "compose", "compose.yaml");
  if (!existsSync(composeFile)) throw new DockpackError("Production bundle has no compose/compose.yaml.");
  const docker = new DockerRunner();
  if (!docker.available()) throw new DockpackError("Docker CLI and daemon are required for deployment.");
  if (docker.platform().id !== manifest.target_platform) throw new DockpackError(`Bundle targets ${manifest.target_platform}; Docker daemon uses ${docker.platform().id}.`);
  if (importImages || activateImages) {
    const expectedIds = await readProductionImageIds(root, manifest);
    const matches = expectedIds && manifest.images.every((image) => docker.hasImage(image) && docker.imageId(image) === expectedIds[image]);
    // Old bundles lack image IDs; always reload them when activating a version.
    if (importImages || !matches) {
      for (const name of await readdir(path.join(root, "images"))) {
        if (name.endsWith(".tar")) docker.load(path.join(root, "images", name));
      }
    }
    for (const image of manifest.images) {
      if (!docker.hasImage(image)) throw new DockpackError(`Bundle image import is incomplete: ${image}`);
      if (expectedIds && docker.imageId(image) !== expectedIds[image]) {
        throw new DockpackError(`Imported image ${image} does not match the production bundle image ID.`);
      }
      if (docker.imagePlatform(image) !== manifest.target_platform) {
        throw new DockpackError(`Imported image ${image} does not match the production bundle platform.`);
      }
    }
  }
  return { root, composeFile, manifest, projectName: `dockpack-${slug(manifest.project_name)}` };
}

function composeArgs(deployment: Deployment): string[] {
  const args = ["-p", deployment.projectName, "-f", deployment.composeFile];
  const envFile = path.join(deployment.root, ".env");
  if (existsSync(envFile)) args.push("--env-file", envFile);
  return args;
}

function requireCompose(): string[] {
  const command = getComposeCommand();
  if (!command) throw new DockpackError("Neither 'docker compose' nor 'docker-compose' is available.");
  return command.prefix;
}

function missingEnvValues(deployment: Deployment): string[] {
  const envFile = path.join(deployment.root, ".env");
  const supplied = new Set(Object.keys(process.env));
  if (existsSync(envFile)) {
    const text = readTextSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match?.[1]) supplied.add(match[1]);
    }
  }
  return deployment.manifest.required_config.filter((key) => !supplied.has(key));
}

function composeCall(deployment: Deployment, args: string[]): string {
  return runCompose([...composeArgs(deployment), ...args], deployment.root);
}

function requireOfflineStartup(): void {
  if (requireCompose()[0] !== "docker") {
    throw new DockpackError("Docker Compose v2 ('docker compose') is required to start production services with --pull never. Upgrade legacy docker-compose before deploying or restoring services.");
  }
}

function startProduction(deployment: Deployment): void {
  composeCall(deployment, ["up", "-d", "--no-build", "--pull", "never"]);
}

async function validateArchivePaths(archivePath: string): Promise<void> {
  const entries: Array<{ path: string; type: string }> = [];
  await tar.list({ file: archivePath, onReadEntry: (entry) => entries.push({ path: entry.path, type: entry.type }) });
  const seen = new Set<string>();
  for (const entry of entries) {
    let normalized = entry.path.replaceAll("\\", "/");
    while (normalized.startsWith("./")) normalized = normalized.slice(2);
    normalized = normalized.replace(/\/$/, "");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new DockpackError(`Unsafe archive path: ${entry.path}`);
    }
    if (normalized === "" && entry.type === "Directory") continue;
    if (seen.has(entry.path)) throw new DockpackError(`Duplicate archive entry: ${entry.path}`);
    seen.add(entry.path);
    if (entry.type !== "File" && entry.type !== "Directory") throw new DockpackError(`Unsupported archive entry type: ${entry.type} (${entry.path})`);
  }
}

export async function importProductionBundle(bundlePath: string): Promise<void> {
  const deployment = await loadDeployment(bundlePath, true);
  console.log(`Imported production bundle ${deployment.manifest.project_name} to ${deployment.root}`);
}

export async function upProduction(bundlePath: string): Promise<void> {
  requireOfflineStartup();
  const deployment = await loadDeployment(bundlePath, false, true);
  const missing = missingEnvValues(deployment);
  if (missing.length) {
    throw new DockpackError(`Set required production variables in ${path.join(deployment.root, ".env")} or the process environment: ${missing.join(", ")}`);
  }
  startProduction(deployment);
  console.log(`Started ${deployment.manifest.project_name}`);
}

export async function downProduction(bundlePath: string): Promise<void> {
  const deployment = await loadDeployment(bundlePath, false);
  composeCall(deployment, ["down"]);
  console.log("Stopped Compose services. Named volumes were retained.");
}

export async function statusProduction(bundlePath: string): Promise<void> {
  const deployment = await loadDeployment(bundlePath, false);
  console.log(composeCall(deployment, ["ps"]));
}

export async function logsProduction(bundlePath: string, service?: string): Promise<void> {
  const deployment = await loadDeployment(bundlePath, false);
  const command = requireCompose();
  const { spawnSync } = await import("node:child_process");
  const args = [...composeArgs(deployment), "logs", "--follow", ...(service ? [service] : [])];
  const result = spawnSync(command[0]!, [...command.slice(1), ...args], { cwd: deployment.root, stdio: "inherit" });
  if (result.error) throw new DockpackError(`Cannot read service logs: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new DockpackError(`Compose logs exited with code ${result.status ?? 1}.`);
}

async function parseVolumes(deployment: Deployment): Promise<Array<{ source: string; mountpoint: string }>> {
  if (process.platform !== "linux") throw new DockpackError("Volume backup/restore requires a local Linux Docker host; the production bundle itself targets Linux amd64.");
  const model = parse(await readFile(deployment.composeFile, "utf8")) as {
    services?: Record<string, { volumes?: Array<string | { type?: string; source?: string }> }>;
    volumes?: Record<string, { name?: string; external?: boolean }>;
  };
  const used = new Set<string>();
  for (const service of Object.values(model.services ?? {})) {
    for (const volume of service.volumes ?? []) {
      if (typeof volume === "string") {
        const source = volume.split(":")[0] ?? "";
        if (source && !source.startsWith(".") && !path.isAbsolute(source)) used.add(source);
      } else if (volume.type === "volume" && volume.source) used.add(volume.source);
    }
  }
  const docker = new DockerRunner();
  const result: Array<{ source: string; mountpoint: string }> = [];
  for (const source of used) {
    const config = model.volumes?.[source];
    if (config?.external) continue;
    const actualName = config?.name ?? `${deployment.projectName}_${source}`;
    const mountpoint = docker.run(["volume", "inspect", "--format", "{{.Mountpoint}}", actualName]);
    result.push({ source, mountpoint });
  }
  return result;
}

export async function backupProduction(bundlePath: string, outputPath?: string): Promise<string> {
  requireOfflineStartup();
  const deployment = await loadDeployment(bundlePath, false, true);
  const volumes = await parseVolumes(deployment);
  if (volumes.length === 0) throw new DockpackError("No internal named volumes were found in this production bundle.");
  const output = path.resolve(outputPath ?? `${deployment.manifest.project_name}-backup-${new Date().toISOString().replaceAll(":", "-")}.tar.gz`);
  const stage = await mkdtemp(path.join(os.tmpdir(), "dockpack-backup-"));
  try {
    composeCall(deployment, ["stop"]);
    await mkdir(path.join(stage, "volumes"), { recursive: true });
    const metadata: Array<{ name: string; file: string; sha256: string }> = [];
    for (const volume of volumes) {
      const volumeHash = createHash("sha256").update(volume.source).digest("hex").slice(0, 8);
      const archiveName = `${slug(volume.source)}-${volumeHash}.tar`;
      const target = path.join(stage, "volumes", archiveName);
      await tar.create({ cwd: volume.mountpoint, file: target, portable: true }, ["."]);
      metadata.push({ name: volume.source, file: `volumes/${archiveName}`, sha256: await digestFile(target) });
    }
    await writeFile(path.join(stage, "backup.json"), `${JSON.stringify({ schema_version: 1, project_name: deployment.manifest.project_name, created_at: new Date().toISOString(), volumes: metadata }, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(output), { recursive: true });
    await tar.create({ gzip: true, file: output, cwd: stage, portable: true }, ["backup.json", "volumes"]);
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
    startProduction(deployment);
  }
}

export async function restoreProduction(bundlePath: string, backupPath: string, overwrite: boolean): Promise<void> {
  requireOfflineStartup();
  const deployment = await loadDeployment(bundlePath, false, true);
  const volumes = await parseVolumes(deployment);
  const stage = await mkdtemp(path.join(os.tmpdir(), "dockpack-restore-"));
  try {
    await validateArchivePaths(path.resolve(backupPath));
    await tar.extract({ file: path.resolve(backupPath), cwd: stage, strict: true });
    const backup = JSON.parse(await readFile(path.join(stage, "backup.json"), "utf8")) as { project_name: string; volumes: Array<{ name: string; file: string; sha256: string }> };
    if (backup.project_name !== deployment.manifest.project_name) throw new DockpackError("Backup belongs to a different project.");
    const plans: Array<{ item: (typeof backup.volumes)[number]; volume: { source: string; mountpoint: string }; file: string }> = [];
    for (const item of backup.volumes) {
      const target = volumes.find((volume) => volume.source === item.name);
      if (!target) throw new DockpackError(`Backup contains unknown volume '${item.name}'.`);
      if (path.isAbsolute(item.file) || item.file.split(/[\\/]/).includes("..")) throw new DockpackError(`Unsafe backup member path: ${item.file}`);
      const file = path.join(stage, item.file);
      const hash = await digestFile(file);
      if (hash !== item.sha256) throw new DockpackError(`Backup checksum mismatch for ${item.name}.`);
      await validateArchivePaths(file);
      const entries = await readdir(target.mountpoint);
      if (entries.length > 0 && !overwrite) throw new DockpackError(`Volume '${item.name}' is not empty. Pass --overwrite to replace its contents.`);
      plans.push({ item, volume: target, file });
    }
    composeCall(deployment, ["stop"]);
    try {
      for (const { item, volume: target, file } of plans) {
        const entries = await readdir(target.mountpoint);
        if (overwrite) {
          const stash = await mkdtemp(path.join(path.dirname(target.mountpoint), ".dockpack-volume-stash-"));
          for (const entry of entries) await rename(path.join(target.mountpoint, entry), path.join(stash, entry));
          try {
            await tar.extract({ file, cwd: target.mountpoint, strict: true });
            await rm(stash, { recursive: true, force: true });
          } catch (error) {
            for (const entry of await readdir(stash)) await rename(path.join(stash, entry), path.join(target.mountpoint, entry));
            await rm(stash, { recursive: true, force: true });
            throw error;
          }
        } else {
          await tar.extract({ file, cwd: target.mountpoint, strict: true });
        }
      }
    } finally {
      startProduction(deployment);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function digestFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
