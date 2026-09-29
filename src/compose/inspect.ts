import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const COMPOSE_PRIORITY = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export interface ComposeService {
  name: string;
  image?: string;
  build?: unknown;
  [key: string]: unknown;
}

export interface ComposeAnalysis {
  files: string[];
  services: ComposeService[];
  findings: string[];
  normalized: boolean;
}

export interface ComposeModel {
  services: Record<string, Record<string, unknown>>;
  volumes?: Record<string, Record<string, unknown>>;
  networks?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function detectComposeCommand(): string[] | undefined {
  const candidates = [["docker", "compose"], ["docker-compose"]];
  for (const command of candidates) {
    const result = spawnSync(command[0]!, [...command.slice(1), "version"], { encoding: "utf8", timeout: 8000 });
    if (result.status === 0) return command;
  }
  return undefined;
}

export async function resolveComposeModel(projectDir: string, files: string[], profiles: string[] = []): Promise<ComposeModel> {
  const command = detectComposeCommand();
  if (!command) {
    if (files.length !== 1) throw new Error("Docker Compose is required to correctly resolve multiple Compose files.");
    const model = parse(await readFile(files[0]!, "utf8")) as ComposeModel;
    if (!model || typeof model !== "object" || !model.services) throw new Error("Compose file has no services mapping.");
    return model;
  }
  if (command[0] === "docker-compose" && profiles.length > 0) throw new Error("Legacy docker-compose does not support Compose profiles; install the Compose plugin or remove profiles.");
  const args = [...command.slice(1)];
  for (const file of files) args.push("-f", path.resolve(projectDir, file));
  if (command[0] === "docker") for (const profile of profiles) args.push("--profile", profile);
  args.push("config");
  if (command[0] === "docker") args.push("--format", "json", "--no-interpolate");
  else args.push("--no-interpolate");
  const result = spawnSync(command[0]!, args, { cwd: projectDir, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Compose normalization failed: ${(result.stderr || result.stdout || "unknown Compose error").trim()}`);
  const model = command[0] === "docker" ? JSON.parse(result.stdout) as ComposeModel : parse(result.stdout) as ComposeModel;
  if (!model || typeof model !== "object" || !model.services) throw new Error("Compose returned a model without services.");
  return model;
}

export async function discoverComposeFiles(projectDir: string): Promise<string[]> {
  const rootNames = new Set(await readdir(projectDir));
  const rootSelected = COMPOSE_PRIORITY.find((name) => rootNames.has(name));
  if (rootSelected) return composeFilesFor(projectDir, rootSelected);
  const candidates = await nestedComposeCandidates(projectDir);
  if (candidates.length !== 1) return [];
  return composeFilesFor(path.dirname(candidates[0]!), path.basename(candidates[0]!));
}

async function nestedComposeCandidates(projectDir: string): Promise<string[]> {
  const ignored = new Set([".git", ".dockpack", "node_modules", "dist", "build", "coverage", "vendor"]);
  const candidates: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const selected = COMPOSE_PRIORITY.find((name) => names.has(name));
    if (selected) candidates.push(path.join(directory, selected));
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(path.join(directory, entry.name), depth + 1);
    }
  }
  await walk(projectDir, 1);
  return candidates;
}

async function composeFilesFor(directory: string, selected: string): Promise<string[]> {
  const files = [path.join(directory, selected)];
  const override = selected.replace(/\.(ya?ml)$/, ".override.$1");
  if (selected !== override) {
    try {
      await access(path.join(directory, override));
      files.push(path.join(directory, override));
    } catch { /* no optional override */ }
  }
  return files;
}

function normalizeServices(value: unknown): ComposeService[] {
  if (!value || typeof value !== "object") return [];
  const services = (value as { services?: Record<string, unknown> }).services;
  if (!services || typeof services !== "object") return [];
  return Object.entries(services).map(([name, config]) => ({
    name,
    ...((config && typeof config === "object") ? config : {}),
  })) as ComposeService[];
}

function serviceFindings(services: ComposeService[], projectDir: string): string[] {
  const findings: string[] = [];
  for (const service of services) {
    if (!service.image && !service.build) findings.push(`Service '${service.name}' has neither image nor build configuration.`);
    if (service.network_mode === "host") findings.push(`Service '${service.name}' uses host networking; portability needs review.`);
    if (Array.isArray(service.devices) && service.devices.length > 0) findings.push(`Service '${service.name}' maps host devices; portability needs review.`);
    if (Array.isArray(service.volumes)) {
      for (const volume of service.volumes) {
        if (typeof volume === "string" && path.isAbsolute(volume.split(":")[0] ?? "")) {
          const source = volume.split(":")[0]!;
          const relative = path.relative(projectDir, source);
          findings.push(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
            ? `Service '${service.name}' uses project-local bind source '${relative}'.`
            : `Service '${service.name}' uses a host bind source outside the project; configure it for the target host.`);
        } else if (volume && typeof volume === "object" && (volume as { type?: string }).type === "bind") {
          const source = (volume as { source?: string }).source ?? "";
          if (path.isAbsolute(source)) {
            const relative = path.relative(projectDir, source);
            findings.push(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
              ? `Service '${service.name}' uses project-local bind source '${relative}'.`
              : `Service '${service.name}' uses a host bind source outside the project; configure it for the target host.`);
          }
        }
      }
    }
  }
  return findings;
}

export async function analyzeCompose(projectDir: string, configuredFiles?: string[], profiles: string[] = []): Promise<ComposeAnalysis> {
  const discovered = configuredFiles?.map((file) => path.resolve(projectDir, file)) ?? await discoverComposeFiles(projectDir);
  if (configuredFiles === undefined && discovered.length === 0) {
    const candidates = await nestedComposeCandidates(projectDir);
    if (candidates.length > 1) {
      const names = candidates.map((file) => path.relative(projectDir, file)).join(", ");
      return { files: [], services: [], findings: [`Found multiple nested Compose projects (${names}); set compose.files in .dockpack.yaml.`], normalized: false };
    }
  }
  if (discovered.length === 0) return { files: [], services: [], findings: [], normalized: true };
  const command = detectComposeCommand();
  const findings: string[] = [];
  if (command) {
    const args = [...command.slice(1)];
    for (const file of discovered) args.push("-f", file);
    if (command[0] === "docker-compose" && profiles.length > 0) {
      findings.push("Legacy docker-compose does not support profiles; install the Compose plugin or remove profiles.");
      return { files: discovered, services: [], findings, normalized: false };
    }
    if (command[0] === "docker") for (const profile of profiles) args.push("--profile", profile);
    args.push("config");
    if (command[0] === "docker") args.push("--format", "json", "--no-interpolate");
    else args.push("--no-interpolate");
    const result = spawnSync(command[0]!, args, { cwd: projectDir, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    if (result.status === 0) {
      try {
        const model: unknown = command[0] === "docker" ? JSON.parse(result.stdout) : parse(result.stdout);
        const services = normalizeServices(model);
        return { files: discovered, services, findings: serviceFindings(services, projectDir), normalized: true };
      } catch (error) {
        findings.push(`Compose returned invalid normalized JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      findings.push(`Compose normalization failed: ${(result.stderr || result.stdout || "unknown Compose error").trim()}`);
    }
  } else {
    findings.push("Docker Compose was not found; service listing is a basic YAML preview, not fully resolved.");
    if (discovered.length > 1) findings.push("Multiple Compose files require the Compose CLI for correct merge semantics.");
  }

  let services: ComposeService[] = [];
  if (!command && discovered.length === 1) {
    const source = await readFile(discovered[0]!, "utf8");
    services = normalizeServices(parse(source));
  }
  findings.push(...serviceFindings(services, projectDir));
  return { files: discovered, services, findings: [...new Set(findings)], normalized: false };
}
