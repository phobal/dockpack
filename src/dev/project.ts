import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { bundleCachePath, bundleFingerprint, extractArchive } from "../bundles/archive.js";
import { readConfig } from "../config/io.js";
import { DockpackError } from "../errors.js";
import { DockerRunner } from "../docker/runner.js";
import { runCompose, runComposeAttached, getComposeCommand } from "../compose/command.js";
import { analyzeCompose } from "../compose/inspect.js";
import { sha256Files } from "./dependencies.js";
import { detectProject, inferDevelopmentServer } from "../project/detect.js";
import { defaultDevelopmentBundlePath } from "./bundle-path.js";

interface ProjectState {
  schema_version: 1;
  bundle_id: string;
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
    const state = JSON.parse(await readFile(file, "utf8")) as ProjectState & { bundle_root?: string; project_dir?: string };
    if (!state.bundle_id) throw new Error("bundle_id is missing");
    state.compose_overlay = path.join(".dockpack", "compose.dev.yaml");
    delete state.bundle_root;
    delete state.project_dir;
    const manifestPath = path.join(bundleCachePath(state.bundle_id), "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new DockpackError(`The imported development bundle cache is missing. Run 'dockpack dev init --bundle <bundle>' on this machine.`);
    }
    await writeOverlay(projectDir, state, "restore");
    return state;
  } catch (error) {
    if (error instanceof DockpackError) throw error;
    throw new DockpackError(`No initialized Dockpack development environment in ${projectDir}. Run 'dockpack dev init' first.`, { cause: error });
  }
}

async function writeOverlay(root: string, state: ProjectState, version: string, configOverride?: Awaited<ReturnType<typeof readConfig>>): Promise<void> {
  const config = configOverride ?? await readConfig(path.join(root, ".dockpack.yaml"));
  const bundleRoot = bundleCachePath(state.bundle_id);
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, "manifest.json"), "utf8")) as { images: string[]; services: string[]; target_platform: string };
  if (config.target.dev_platform !== "auto" && config.target.dev_platform !== manifest.target_platform) {
    throw new DockpackError(`target.dev_platform is ${config.target.dev_platform}, but the development bundle targets ${manifest.target_platform}. Import a matching development bundle with 'dockpack dev init'.`);
  }
  const services: Record<string, unknown> = {};
  for (const service of manifest.services) services[service] = { platform: manifest.target_platform };
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
      platform: manifest.target_platform,
      working_dir: "/workspace",
      command: config.application.dev_command.length > 0 ? config.application.dev_command : ["sleep", "infinity"],
      ...(config.application.dev_port ? { ports: [`${config.application.dev_port}:${config.application.dev_port}`] } : {}),
      volumes: [
        { type: "bind", source: "${DOCKPACK_PROJECT_DIR}", target: "/workspace" },
        { type: "volume", source: volumeKey, target: ecosystem === "python" ? "/opt/dockpack/deps" : "/workspace/node_modules" },
      ],
      ...(ecosystem === "python" ? { environment: { VIRTUAL_ENV: "/opt/dockpack/deps", PATH: "/opt/dockpack/deps/bin:/usr/local/bin:/usr/bin:/bin" } } : {}),
    };
    volumes[volumeKey] = { name: dockerVolume };
  }
  const overlayFile = path.join(root, ".dockpack", "compose.dev.yaml");
  await writeFile(overlayFile, stringify({ services, volumes }), "utf8");
  state.compose_overlay = path.join(".dockpack", "compose.dev.yaml");
  await writeFile(path.join(root, ".dockpack", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function composePrefix(root: string, state: ProjectState, extraFiles: string[] = []): Promise<string[]> {
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const analysis = await analyzeCompose(root, config.compose.files);
  const result: string[] = [];
  for (const file of analysis.files) result.push("-f", file);
  result.push("-f", path.resolve(root, state.compose_overlay));
  for (const file of extraFiles) result.push("-f", file);
  if (config.compose.profiles.length > 0) {
    const command = getComposeCommand();
    if (command?.prefix[0] !== "docker") throw new DockpackError("Legacy docker-compose does not support profiles; use the Compose plugin or remove profiles.");
    for (const profile of config.compose.profiles) result.push("--profile", profile);
  }
  return result;
}

async function compose(root: string, state: ProjectState, args: string[], options: { extraFiles?: string[]; cacheDir?: string } = {}): Promise<string> {
  if (!getComposeCommand()) throw new DockpackError("Neither 'docker compose' nor 'docker-compose' is available.");
  const env = {
    ...process.env,
    DOCKPACK_PROJECT_DIR: root,
    ...(options.cacheDir ? { DOCKPACK_CACHE_DIR: options.cacheDir } : {}),
  };
  return runCompose([...await composePrefix(root, state, options.extraFiles), ...args], root, env);
}

async function withInstallCache<T>(root: string, state: ProjectState, ecosystem: string, run: (overlay: string, cacheDir: string) => Promise<T>): Promise<T> {
  const service = `dockpack-dev-${ecosystem}`;
  const overlay = path.join(root, ".dockpack", "compose.install.yaml");
  const cacheDir = path.join(bundleCachePath(state.bundle_id), "cache");
  if (!existsSync(cacheDir)) throw new DockpackError("Dependency cache is missing; import the development bundle again.");
  await writeFile(overlay, stringify({ services: { [service]: { volumes: [
    { type: "bind", source: "${DOCKPACK_CACHE_DIR}", target: "/dockpack-cache", read_only: true },
  ] } } }), "utf8");
  try {
    return await run(overlay, cacheDir);
  } finally {
    await rm(overlay, { force: true });
  }
}

async function installOne(root: string, state: ProjectState, ecosystem: string): Promise<void> {
  const service = `dockpack-dev-${ecosystem}`;
  if (ecosystem === "python") {
    const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => state.dependencies.python && exists(path.join(root, name)));
    if (!requirements) throw new DockpackError("Python offline installation requires requirements.txt or requirements-dev.txt.");
    await withInstallCache(root, state, ecosystem, async (overlay, cacheDir) => {
      await compose(root, state, ["run", "--rm", "--no-deps", service, "python", "-m", "venv", "/opt/dockpack/deps"], { extraFiles: [overlay], cacheDir });
      await compose(root, state, [
        "run", "--rm", "--no-deps", service, "/opt/dockpack/deps/bin/python", "-m", "pip", "install",
        "--no-index", "--find-links", "/dockpack-cache/python", "-r", `/workspace/${requirements}`,
      ], { extraFiles: [overlay], cacheDir });
    });
    return;
  }
  if (ecosystem === "node") {
    await withInstallCache(root, state, ecosystem, async (overlay, cacheDir) => {
      await compose(root, state, ["run", "--rm", "--no-deps", service, "npm", "ci", "--offline", "--cache", "/dockpack-cache/npm"], { extraFiles: [overlay], cacheDir });
    });
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

export async function initializeDevProject(projectDir: string, suppliedBundle?: string): Promise<void> {
  const root = path.resolve(projectDir);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const docker = new DockerRunner();
  let bundlePath = suppliedBundle;
  if (bundlePath === undefined) {
    let platform: string = config.target.dev_platform;
    if (platform === "auto") {
      if (!docker.available()) throw new DockpackError("Docker CLI and daemon are required to resolve target.dev_platform=auto. Start Docker before initializing the project.");
      platform = docker.platform().id;
    }
    bundlePath = defaultDevelopmentBundlePath(root, platform);
    if (!existsSync(bundlePath)) {
      throw new DockpackError(`Default development bundle not found: ${bundlePath}. Copy the matching development bundle to this path or specify --bundle <path>.`);
    }
  }
  console.log(`[dockpack] Initializing development project: ${root}`);
  console.log(`[dockpack] Development bundle: ${path.resolve(bundlePath)}`);
  const temp = await mkdtemp(path.join(os.tmpdir(), "dockpack-import-"));
  try {
    const bundleRoot = await extractArchive(bundlePath, temp);
    const manifest = JSON.parse(await readFile(path.join(bundleRoot, "manifest.json"), "utf8")) as {
      bundle_kind: string; project_name: string; target_platform: string; dependencies: Record<string, string>;
    };
    if (manifest.bundle_kind !== "dev") throw new DockpackError("The supplied archive is not a development bundle.");
    if (config.target.dev_platform !== "auto" && config.target.dev_platform !== manifest.target_platform) {
      throw new DockpackError(`target.dev_platform is ${config.target.dev_platform}, but the development bundle targets ${manifest.target_platform}. Use a matching bundle or update .dockpack.yaml.`);
    }
    const missingEcosystems = config.project.ecosystems.filter((ecosystem) => !manifest.dependencies[ecosystem]);
    if (missingEcosystems.length) throw new DockpackError(`Bundle is missing dependencies for: ${missingEcosystems.join(", ")}`);
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
      bundle_id: await bundleFingerprint(bundlePath),
      compose_overlay: path.join(".dockpack", "compose.dev.yaml"),
      dependencies: manifest.dependencies,
      dependency_volumes: {},
    };
    await verifyDependencyInputs(root, state);
    await mkdir(path.join(root, ".dockpack"), { recursive: true });
    await writeOverlay(root, state, "current");
    for (const ecosystem of config.project.ecosystems) await installOne(root, state, ecosystem);
    state.installed_dependencies = state.dependencies;
    await writeFile(path.join(root, ".dockpack", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
  if (config.application.dev_command.length === 0) {
    const inferred = await inferDevelopmentServer(root, await detectProject(root), config.application.dev_port);
    config.application.dev_command = inferred.command;
    config.application.dev_port = inferred.port ?? config.application.dev_port;
  }
  await writeOverlay(root, state, "current", config);
  const serviceNames = config.project.ecosystems.map((ecosystem) => `dockpack-dev-${ecosystem}`);
  const services = [...config.compose.include_services, ...serviceNames];
  console.log(config.application.dev_command.length > 0
    ? `Starting development server${config.application.dev_port ? ` at http://localhost:${config.application.dev_port}` : ""}. Press Ctrl+C to stop and remove the development containers.`
    : "Starting development containers. No development server was detected; configure application.dev_command and application.dev_port in .dockpack.yaml.");
  let failure: unknown;
  let exitSignal: NodeJS.Signals | null = null;
  try {
    const result = await runComposeAttached(
      [...await composePrefix(root, state), "up", ...services],
      root,
      { ...process.env, DOCKPACK_PROJECT_DIR: root },
    );
    exitSignal = result.signal;
    if (result.code !== 0 && result.signal === null) throw new DockpackError(`Development services exited with status ${result.code ?? 1}.`);
  } catch (error) {
    failure = error;
  }
  try {
    await compose(root, state, ["rm", "-sf", ...services]);
  } catch (cleanupError) {
    if (failure) console.error(`dockpack: cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    else failure = cleanupError;
  }
  if (failure) throw failure;
  if (exitSignal) process.exitCode = exitSignal === "SIGINT" ? 130 : exitSignal === "SIGTERM" ? 143 : 1;
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
  ], { cwd: root, env: { ...process.env, DOCKPACK_PROJECT_DIR: root }, stdio: "inherit" });
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
