import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { bundleFingerprint, extractArchive } from "../bundles/archive.js";
import { readConfig } from "../config/io.js";
import { DockpackError } from "../errors.js";
import { DockerRunner } from "../docker/runner.js";
import { runCompose, getComposeCommand } from "../compose/command.js";
import { analyzeCompose } from "../compose/inspect.js";
import { sha256Files } from "./dependencies.js";

interface ProjectState {
  schema_version: 1;
  project_dir: string;
  bundle_id: string;
  bundle_root: string;
  compose_overlay: string;
  dependencies: Record<string, string>;
  installed_dependencies?: Record<string, string>;
  dependency_volumes: Record<string, string>;
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "project";
}

function volumeName(root: string, ecosystem: string, version: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 10);
  return `dockpack-${safeName(path.basename(root))}-${ecosystem}-${hash}-${version}`;
}

async function readState(projectDir: string): Promise<ProjectState> {
  const file = path.join(projectDir, ".dockpack", "state.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as ProjectState;
  } catch (error) {
    throw new DockpackError(`No initialized Dockpack development environment in ${projectDir}. Run 'dockpack dev init' first.`, { cause: error });
  }
}

async function writeOverlay(root: string, state: ProjectState, version: string): Promise<void> {
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const manifest = JSON.parse(await readFile(path.join(state.bundle_root, "manifest.json"), "utf8")) as { images: string[] };
  const services: Record<string, unknown> = {};
  const volumes: Record<string, { name: string }> = {};
  for (const ecosystem of config.project.ecosystems) {
    const serviceName = `dockpack-dev-${ecosystem}`;
    const runtimePrefix = ecosystem === "python" ? "python:" : "node:";
    const image = manifest.images.find((item) => item.startsWith(runtimePrefix));
    if (!image) throw new DockpackError(`Development bundle has no ${ecosystem} runtime image.`);
    const volumeKey = `dockpack-${ecosystem}-dependencies`;
    const dockerVolume = version === "restore"
      ? state.dependency_volumes[ecosystem] ?? volumeName(root, ecosystem, "current")
      : volumeName(root, ecosystem, version);
    state.dependency_volumes[ecosystem] = dockerVolume;
    services[serviceName] = {
      image,
      working_dir: "/workspace",
      command: ["sleep", "infinity"],
      volumes: [
        { type: "bind", source: root, target: "/workspace" },
        { type: "volume", source: volumeKey, target: ecosystem === "python" ? "/opt/dockpack/deps" : "/workspace/node_modules" },
        { type: "bind", source: path.join(state.bundle_root, "cache"), target: "/dockpack-cache", read_only: true },
      ],
      ...(ecosystem === "python" ? { environment: { VIRTUAL_ENV: "/opt/dockpack/deps", PATH: "/opt/dockpack/deps/bin:/usr/local/bin:/usr/bin:/bin" } } : {}),
    };
    volumes[volumeKey] = { name: dockerVolume };
  }
  const overlayFile = path.join(root, ".dockpack", "compose.dev.yaml");
  await writeFile(overlayFile, stringify({ services, volumes }), "utf8");
  state.compose_overlay = overlayFile;
  await writeFile(path.join(root, ".dockpack", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function composePrefix(root: string, state: ProjectState): Promise<string[]> {
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const analysis = await analyzeCompose(root, config.compose.files);
  const result: string[] = [];
  for (const file of analysis.files) result.push("-f", file);
  result.push("-f", state.compose_overlay);
  if (config.compose.profiles.length > 0) {
    const command = getComposeCommand();
    if (command?.prefix[0] !== "docker") throw new DockpackError("Legacy docker-compose does not support profiles; use the Compose plugin or remove profiles.");
    for (const profile of config.compose.profiles) result.push("--profile", profile);
  }
  return result;
}

async function compose(root: string, state: ProjectState, args: string[]): Promise<string> {
  const command = getComposeCommand();
  if (!command) throw new DockpackError("Neither 'docker compose' nor 'docker-compose' is available.");
  return runCompose(command.prefix, [...await composePrefix(root, state), ...args], root);
}

async function installOne(root: string, state: ProjectState, ecosystem: string): Promise<void> {
  const service = `dockpack-dev-${ecosystem}`;
  if (ecosystem === "python") {
    const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => state.dependencies.python && exists(path.join(root, name)));
    if (!requirements) throw new DockpackError("Python offline installation requires requirements.txt or requirements-dev.txt.");
    await compose(root, state, ["run", "--network", "none", "--rm", "--no-deps", service, "python", "-m", "venv", "/opt/dockpack/deps"]);
    await compose(root, state, [
      "run", "--network", "none", "--rm", "--no-deps", service, "/opt/dockpack/deps/bin/python", "-m", "pip", "install",
      "--no-index", "--find-links", "/dockpack-cache/python", "-r", `/workspace/${requirements}`,
    ]);
    return;
  }
  if (ecosystem === "node") {
    await compose(root, state, ["run", "--network", "none", "--rm", "--no-deps", service, "npm", "ci", "--offline", "--cache", "/dockpack-cache/npm"]);
    return;
  }
  throw new DockpackError(`Unsupported ecosystem: ${ecosystem}`);
}

async function verifyDependencyInputs(root: string, state: ProjectState): Promise<void> {
  const current: Record<string, string> = {};
  if (state.dependencies.python) {
    const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => state.dependencies.python && exists(path.join(root, name)));
    if (!requirements) throw new DockpackError("The Python requirements file included in this bundle is missing.");
    current.python = await sha256Files(root, [requirements]);
  }
  if (state.dependencies.node) {
    if (!exists(path.join(root, "package-lock.json"))) throw new DockpackError("package-lock.json included in this bundle is missing.");
    current.node = await sha256Files(root, ["package-lock.json"]);
  }
  if (JSON.stringify(current) !== JSON.stringify(state.dependencies)) {
    throw new DockpackError("Dependency files differ from the offline bundle; new or changed dependencies require an updated connected bundle.");
  }
}

function exists(file: string): boolean { return existsSync(file); }

export async function initializeDevProject(projectDir: string, bundlePath: string): Promise<void> {
  const root = path.resolve(projectDir);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const temp = await mkdtemp(path.join(os.tmpdir(), "dockpack-import-"));
  try {
    const bundleRoot = await extractArchive(bundlePath, temp);
    const manifest = JSON.parse(await readFile(path.join(bundleRoot, "manifest.json"), "utf8")) as {
      bundle_kind: string; project_name: string; target_platform: string; dependencies: Record<string, string>;
    };
    if (manifest.bundle_kind !== "dev") throw new DockpackError("The supplied archive is not a development bundle.");
    const missingEcosystems = config.project.ecosystems.filter((ecosystem) => !manifest.dependencies[ecosystem]);
    if (missingEcosystems.length) throw new DockpackError(`Bundle is missing dependencies for: ${missingEcosystems.join(", ")}`);
    const docker = new DockerRunner();
    if (!docker.available()) throw new DockpackError("Docker CLI and daemon are required to initialize the project.");
    if (docker.platform().id !== manifest.target_platform) throw new DockpackError(`Bundle targets ${manifest.target_platform}; Docker daemon uses ${docker.platform().id}.`);
    const cacheRoot = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "dockpack", "bundles", await bundleFingerprint(bundlePath));
    await mkdir(path.dirname(cacheRoot), { recursive: true });
    await rm(cacheRoot, { recursive: true, force: true });
    const permanentRoot = await extractArchive(bundlePath, cacheRoot);
    const imageArchives = await (await import("node:fs/promises")).readdir(path.join(permanentRoot, "images"));
    for (const filename of imageArchives) if (filename.endsWith(".tar")) docker.load(path.join(permanentRoot, "images", filename));
    const state: ProjectState = {
      schema_version: 1,
      project_dir: root,
      bundle_id: await bundleFingerprint(bundlePath),
      bundle_root: permanentRoot,
      compose_overlay: path.join(root, ".dockpack", "compose.dev.yaml"),
      dependencies: manifest.dependencies,
      dependency_volumes: {},
    };
    await verifyDependencyInputs(root, state);
    await mkdir(path.join(root, ".dockpack"), { recursive: true });
    await writeOverlay(root, state, "current");
    for (const ecosystem of config.project.ecosystems) await installOne(root, state, ecosystem);
    state.installed_dependencies = state.dependencies;
    await writeFile(path.join(root, ".dockpack", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const serviceNames = config.project.ecosystems.map((ecosystem) => `dockpack-dev-${ecosystem}`);
    await compose(root, state, ["up", "-d", ...config.compose.include_services, ...serviceNames]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function startDev(projectDir: string): Promise<void> {
  const root = path.resolve(projectDir);
  const state = await readState(root);
  await verifyDependencyInputs(root, state);
  await ensureDependencyInputsMatch(root, state);
  if (JSON.stringify(state.installed_dependencies ?? {}) !== JSON.stringify(state.dependencies)) throw new DockpackError("Dependencies are not installed. Run 'dockpack dev rebuild'.");
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const serviceNames = config.project.ecosystems.map((ecosystem) => `dockpack-dev-${ecosystem}`);
  await compose(root, state, ["up", "-d", ...config.compose.include_services, ...serviceNames]);
}

export async function stopDev(projectDir: string): Promise<void> {
  const root = path.resolve(projectDir);
  const state = await readState(root);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const serviceNames = config.project.ecosystems.map((ecosystem) => `dockpack-dev-${ecosystem}`);
  await compose(root, state, ["stop", ...config.compose.include_services, ...serviceNames]);
}

export async function execDev(projectDir: string, command: string[]): Promise<void> {
  if (command.length === 0) throw new DockpackError("Provide a command after '--'.");
  const root = path.resolve(projectDir);
  const state = await readState(root);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const ecosystem = config.project.ecosystems[0];
  if (!ecosystem) throw new DockpackError("No Python or Node.js environment is configured.");
  const composeCommand = (await import("../compose/command.js")).getComposeCommand();
  if (!composeCommand) throw new DockpackError("Neither 'docker compose' nor 'docker-compose' is available.");
  const { spawnSync } = await import("node:child_process");
  const prefix = await composePrefix(root, state);
  const result = spawnSync(composeCommand.prefix[0]!, [
    ...composeCommand.prefix.slice(1), ...prefix, "exec", "-T", `dockpack-dev-${ecosystem}`, ...command,
  ], { cwd: root, stdio: "inherit" });
  if (result.error) throw new DockpackError(`Cannot execute in development container: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

export async function rebuildDev(projectDir: string): Promise<void> {
  const root = path.resolve(projectDir);
  const state = await readState(root);
  await verifyDependencyInputs(root, state);
  await ensureDependencyInputsMatch(root, state);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const oldVolumes = { ...state.dependency_volumes };
  const nextVersion = `rebuild-${Date.now()}`;
  await writeOverlay(root, state, nextVersion);
  try {
    for (const ecosystem of config.project.ecosystems) await installOne(root, state, ecosystem);
    state.installed_dependencies = state.dependencies;
    await writeFile(path.join(root, ".dockpack", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const services = config.project.ecosystems.map((ecosystem) => `dockpack-dev-${ecosystem}`);
    await compose(root, state, ["up", "-d", "--force-recreate", ...services]);
  } catch (error) {
    state.dependency_volumes = oldVolumes;
    await writeOverlay(root, state, "restore");
    throw error;
  }
}

async function ensureDependencyInputsMatch(root: string, state: ProjectState): Promise<void> {
  const current: Record<string, string> = {};
  if (state.dependencies.python) {
    const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => exists(path.join(root, name)));
    if (!requirements) throw new DockpackError("The Python dependency file from the bundle is missing.");
    current.python = await sha256Files(root, [requirements]);
  }
  if (state.dependencies.node) {
    if (!exists(path.join(root, "package-lock.json"))) throw new DockpackError("package-lock.json from the bundle is missing.");
    current.node = await sha256Files(root, ["package-lock.json"]);
  }
  if (JSON.stringify(current) !== JSON.stringify(state.dependencies)) {
    throw new DockpackError("Dependency inputs changed or include packages outside this offline bundle. Repack on a connected machine.");
  }
}
