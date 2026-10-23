import { logger } from "../logger.js";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { VERSION } from "../version.js";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { createArchive } from "../bundles/archive.js";
import { makeManifest } from "../bundles/manifest.js";
import { getComposeCommand, runCompose } from "../compose/command.js";
import { analyzeCompose, resolveComposeModel, type ComposeModel } from "../compose/inspect.js";
import { readConfig } from "../config/io.js";
import { DockerRunner } from "../docker/runner.js";
import { DockpackError } from "../errors.js";
import { detectProject } from "../project/detect.js";
import { exportProductionImages } from "./images.js";
import { checkedNpmInstall, runtimeImage } from "../dev/dependencies.js";
import { detectStaticFrontend, STATIC_FRONTEND_IMAGE, type StaticFrontend } from "../project/frontend.js";
import { defaultDevelopmentBundlePath } from "../dev/bundle-path.js";
import { defaultProductionBundlePath, prepareProductionResources } from "./resources.js";
import { createFrontendWorkspace } from "./frontend-workspace.js";
import { productionStep } from "./progress.js";

const TARGET = "linux/amd64";

function appImageName(projectName: string, service: string): string {
  const clean = `${projectName}-${service}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `dockpack/${clean}:offline`;
}

function dockerfileFor(ecosystem: string, baseImage: string, requirementsFile: string, command: string[], hasBuildScript: boolean): string {
  if (ecosystem === "python") {
    return [
      `FROM ${baseImage}`,
      "WORKDIR /app",
      "COPY --from=dockpack-cache /python /wheelhouse",
      `COPY ${requirementsFile} ./requirements.txt`,
      "RUN --network=none python -m pip install --no-index --find-links=/wheelhouse -r requirements.txt",
      "COPY . .",
      `CMD ${JSON.stringify(command)}`,
      "",
    ].join("\n");
  }
  const lines = [
    `FROM ${baseImage}`,
    "WORKDIR /app",
    "COPY package.json package-lock.json ./",
    "COPY --from=dockpack-cache /npm /root/.npm",
    "RUN --network=none npm ci --offline --cache /root/.npm",
    "COPY . .",
  ];
  if (hasBuildScript) lines.push("RUN --network=none npm run build", "RUN --network=none npm prune --omit=dev --offline --cache /root/.npm");
  lines.push(`CMD ${JSON.stringify(command)}`, "");
  return lines.join("\n");
}

async function prepareContext(root: string, context: string, frontendMode?: string): Promise<void> {
  const excluded = new Set([".git", ".dockpack", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", "coverage"]);
  await cp(root, context, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const relative = path.relative(root, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      if (parts.some((part) => excluded.has(part))) return false;
      const name = path.basename(source);
      if (/^\.env(?:\..*)?$/.test(name) && name !== ".env.example") {
        if (frontendMode === undefined || relative !== name || (name !== ".env" && name !== `.env.${frontendMode}`)) return false;
      }
      if ([".npmrc", ".pypirc", ".netrc"].includes(name)) return false;
      if (/\.(pem|key|p12|pfx)$/i.test(name)) return false;
      return true;
    },
  });
}

const prepareStaticBuild = String.raw`
import { resolveConfig } from "vite";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
const inline = JSON.parse(process.argv[1]);
const config = await resolveConfig(inline, "build", inline.mode);
if (config.build.ssr || config.build.lib || config.build.watch) {
  throw new Error("Automatic Nginx packaging supports Vite static sites only; configure a Dockerfile for SSR, library, or watch builds.");
}
const output = path.relative("/workspace", path.resolve(config.root, config.build.outDir));
if (!output || path.isAbsolute(output) || output.split(path.sep).some(part => part === "..") || output.split(path.sep)[0] === "node_modules") {
  throw new Error("Vite build.outDir must be a subdirectory of the project for automatic offline packaging.");
}
await rm(path.resolve("/workspace", output), { recursive: true, force: true });
await writeFile("/workspace/.dockpack-static-build.json", JSON.stringify({ output, base: config.base }));
`;

async function buildStaticFrontend(root: string, stage: string, image: string, cacheDir: string, docker: DockerRunner, nodeImage: string, frontend: StaticFrontend): Promise<void> {
  if (!docker.hasImage(STATIC_FRONTEND_IMAGE) || docker.imagePlatform(STATIC_FRONTEND_IMAGE) !== TARGET) {
    throw new DockpackError(`Static frontend production builds need ${STATIC_FRONTEND_IMAGE} for ${TARGET}. Recreate the development bundle with the updated CLI on a connected machine, transfer it, and run 'dockpack build prod' again.`);
  }
  const context = await mkdtemp(path.join(stage, "frontend-build-"));
  const workspace = path.join(context, "workspace");
  let dockerWorkspace: Awaited<ReturnType<typeof createFrontendWorkspace>> | undefined;
  try {
    await productionStep("Copying frontend sources", () => prepareContext(root, workspace, frontend.mode));
    dockerWorkspace = await createFrontendWorkspace(root, workspace, cacheDir, nodeImage, docker);
    const active = dockerWorkspace;
    await productionStep("Resolving Vite production configuration", () => active.run(["node", "--input-type=module", "-e", prepareStaticBuild, "--", JSON.stringify(frontend.vite)]));
    await productionStep(`Building static frontend: ${frontend.command.join(" ")} (network disabled)`, () => active.run(frontend.command));
    const metadata = active.metadata();
    const relative = path.posix.relative("/workspace", path.posix.resolve("/workspace", metadata.output));
    if (!relative || relative.split("/").includes("..") || path.posix.isAbsolute(relative)) {
      throw new DockpackError("The frontend build output must be inside its Docker workspace.");
    }
    const base = metadata.base === "./" || metadata.base === "" ? "/" : metadata.base;
    if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base) || base.split("/").some((part) => part === "." || part === "..")) {
      throw new DockpackError("Automatic Nginx packaging requires a local Vite base path such as '/' or '/app/'; use a custom Dockerfile for other base URLs.");
    }
    const runtime = path.join(context, "runtime");
    const site = path.join(runtime, "site", ...base.split("/").filter(Boolean));
    await mkdir(site, { recursive: true });
    await productionStep("Exporting static frontend assets", () => active.copyOutput(relative, site));
    const locations = [
      ...(base === "/" ? [] : ["    location / { return 404; }", `    location = ${base.slice(0, -1)} { return 302 ${base}; }`]),
      `    location ${base} { try_files $uri $uri/ ${base}index.html; }`,
      "    location ~* \\.(?:js|mjs|css|map|json|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|wasm)$ { try_files $uri =404; }",
    ];
    await writeFile(path.join(runtime, "default.conf"), [
      "server {", "    listen 80;", "    server_name _;", "    root /usr/share/nginx/html;", "    index index.html;", ...locations, "}", "",
    ].join("\n"), "utf8");
    await writeFile(path.join(runtime, "Dockerfile"), [
      `FROM ${STATIC_FRONTEND_IMAGE}`,
      'COPY ["site/", "/usr/share/nginx/html/"]',
      'COPY ["default.conf", "/etc/nginx/conf.d/default.conf"]',
      "EXPOSE 80", "",
    ].join("\n"), "utf8");
    await productionStep("Building Nginx production image", () => docker.run(["buildx", "build", "--pull=false", "--network=none", "--platform", TARGET, "--load", "--tag", image, runtime], { streamOutput: true }));
  } finally {
    try { dockerWorkspace?.cleanup(); }
    finally { await rm(context, { recursive: true, force: true }); }
  }
}

function lockFile(detection: { ecosystem: string; lockFiles: string[]; dependencyFiles: string[] }): string {
  if (detection.ecosystem === "python") {
    const candidate = ["requirements.txt", "requirements-dev.txt"].find((name) => detection.dependencyFiles.includes(name));
    if (!candidate) throw new DockpackError("Generated Python production images currently require requirements.txt.");
    return candidate;
  }
  if (!detection.lockFiles.includes("package-lock.json")) throw new DockpackError("Generated Node.js production images require npm package-lock.json.");
  return "package-lock.json";
}

async function buildGeneratedApplication(root: string, stage: string, image: string, cacheDir: string, docker: DockerRunner, config: Awaited<ReturnType<typeof readConfig>>): Promise<boolean> {
  if (docker.platform().os !== "linux") throw new DockpackError("Production image creation requires a Docker daemon capable of building Linux containers.");
  const detections = await detectProject(root);
  if (detections.length !== 1) throw new DockpackError("Automatic production Dockerfile generation currently supports one application runtime per project.");
  const detection = detections[0]!;
  const file = lockFile(detection);
  const command = config.application.command;
  const frontend = detection.ecosystem === "node" ? await detectStaticFrontend(root, command, config.application.build_command) : undefined;
  if (!frontend && command.length === 0) throw new DockpackError("Set application.command in .dockpack.yaml; Dockpack could not safely infer how to start this project.");
  const runtime = (await import("../dev/dependencies.js")).runtimeImage(detection, root);
  const baseImage = await runtime;
  if (!docker.hasImage(baseImage)) throw new DockpackError(`Required base image ${baseImage} is not present locally. Prepare it in the development bundle before going offline.`);
  if (frontend) {
    await buildStaticFrontend(root, stage, image, cacheDir, docker, baseImage, frontend);
    return true;
  }
  const basePlatform = docker.imagePlatform(baseImage);
  if (basePlatform !== TARGET) throw new DockpackError(`Base image ${baseImage} is ${basePlatform}; production build needs ${TARGET}.`);
  const context = path.join(stage, "build-context");
  await mkdir(context, { recursive: true });
  try {
    await prepareContext(root, context);
    const dockerfile = path.join(context, "Dockerfile.dockpack");
    let hasBuildScript = false;
    if (detection.ecosystem === "node") {
      const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      hasBuildScript = Boolean(packageJson.scripts?.build);
    }
    await writeFile(dockerfile, dockerfileFor(detection.ecosystem, baseImage, file, command, hasBuildScript), "utf8");
    await writeFile(path.join(context, ".dockerignore"), "Dockerfile.dockpack\n", "utf8");
    await productionStep("Building application production image", () => docker.run([
      "buildx", "build", "--pull=false", "--platform", TARGET, "--load", "--tag", image,
      "--file", dockerfile, "--build-context", `dockpack-cache=${cacheDir}`, context,
    ], { streamOutput: true }));
  } finally {
    // Only deployment payload belongs in the archive, never the build workspace.
    await rm(context, { recursive: true, force: true });
  }
  return false;
}

function composePrefix(files: string[], override?: string): string[] {
  const args: string[] = [];
  for (const file of files) args.push("-f", file);
  if (override) args.push("-f", override);
  return args;
}

function needsGeneratedDockerfile(root: string, service: Record<string, unknown> | undefined): boolean {
  if (!service?.build) return false;
  const build = typeof service.build === "object" ? service.build as Record<string, unknown> : { context: service.build };
  const context = typeof build.context === "string" ? build.context : root;
  const contextPath = path.resolve(root, context);
  const dockerfile = typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile";
  const dockerfilePath = path.isAbsolute(dockerfile) ? dockerfile : path.resolve(contextPath, dockerfile);
  if (!existsSync(dockerfilePath) && contextPath === root) return true;
  if (!existsSync(dockerfilePath)) throw new DockpackError(`Application Dockerfile is missing: ${dockerfilePath}. Automatic generation currently requires the project root as build context.`);
  return false;
}

async function validateOfflineBuild(serviceName: string, root: string, buildValue: unknown): Promise<void> {
  const build = typeof buildValue === "string" ? { context: buildValue } : buildValue as Record<string, unknown>;
  const context = typeof build.context === "string" ? path.resolve(root, build.context) : root;
  const dockerfileName = typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile";
  const dockerfile = path.isAbsolute(dockerfileName) ? dockerfileName : path.resolve(context, dockerfileName);
  let content: string;
  try {
    content = await readFile(dockerfile, "utf8");
  } catch (error) {
    throw new DockpackError(`Cannot inspect Dockerfile for service '${serviceName}' at ${dockerfile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (/^\s*#\s*syntax\s*=/im.test(content)) throw new DockpackError(`Service '${serviceName}' uses a Dockerfile syntax frontend that may require a registry. Remove the syntax directive or pre-provision it offline.`);
  if (/^\s*ADD\s+.*(?:https?:\/\/|git@)/im.test(content)) throw new DockpackError(`Service '${serviceName}' uses remote ADD input; offline production builds cannot resolve it.`);
  if (/^\s*RUN\s+.*--network=(?:default|host)\b/im.test(content)) throw new DockpackError(`Service '${serviceName}' explicitly enables build network access in a RUN instruction.`);
  const additionalContexts = build.additional_contexts;
  if (Array.isArray(additionalContexts) && additionalContexts.some((item) => typeof item === "string" && /(?:https?:\/\/|git@|docker-image:\/\/)/.test(item))) {
    throw new DockpackError(`Service '${serviceName}' has a remote additional build context.`);
  }
}

async function runProjectBuildCommand(root: string, workspace: string, cacheDir: string, docker: DockerRunner, ecosystem: string, buildCommand: string[]): Promise<void> {
  if (buildCommand.length === 0) throw new DockpackError("Set application.build_command in .dockpack.yaml to build the project before its existing Dockerfile is packaged.");
  const detection = (await detectProject(root)).find((item) => item.ecosystem === ecosystem);
  if (!detection) throw new DockpackError(`Cannot detect the ${ecosystem} runtime needed by application.build_command.`);
  const image = await runtimeImage(detection, root);
  if (!docker.hasImage(image) || docker.imagePlatform(image) !== TARGET) throw new DockpackError(`The build command needs a local ${TARGET} runtime image: ${image}. Recreate the development bundle.`);
  const frontend = ecosystem === "node" ? await detectStaticFrontend(root, [], buildCommand) : undefined;
  await prepareContext(root, workspace, frontend?.mode);
  if ([workspace, cacheDir].some((value) => value.includes(","))) throw new DockpackError("Docker bind mount paths containing commas are not supported.");
  const run = (command: string[]) => docker.run([
    "run", "--rm", "--pull", "never", "--network", "none", "--platform", TARGET,
    "--mount", `type=bind,source=${workspace},target=/workspace`,
    "--mount", `type=bind,source=${cacheDir},target=/dockpack-cache,readonly`,
    "--workdir", "/workspace", image, ...command,
  ], { streamOutput: true });
  logger.info(`[dockpack] Running application.build_command in an isolated ${TARGET} container (network disabled)...`);
  if (ecosystem === "node") {
    await productionStep("Installing application dependencies offline", () => run(["node", "-e", checkedNpmInstall, "--", "--offline", "--cache", "/dockpack-cache/npm", "--include=dev", "--include=optional"]));
    await productionStep("Running application build command", () => run(buildCommand));
  } else if (ecosystem === "python") {
    const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => existsSync(path.join(workspace, name)));
    if (!requirements) throw new DockpackError("Python production build commands require a requirements file.");
    await productionStep("Installing Python dependencies and building application offline", () => run(["python", "-c", [
      "import json, os, subprocess, sys, venv",
      "venv.create('/tmp/dockpack-build-venv', with_pip=True)",
      "subprocess.run(['/tmp/dockpack-build-venv/bin/python', '-m', 'pip', 'install', '--no-index', '--find-links=/dockpack-cache/python', '-r', sys.argv[2]], check=True)",
      "env = dict(os.environ, VIRTUAL_ENV='/tmp/dockpack-build-venv')",
      "env['PATH'] = '/tmp/dockpack-build-venv/bin:' + env.get('PATH', '')",
      "subprocess.run(json.loads(sys.argv[1]), env=env, check=True)",
    ].join("\n"), JSON.stringify(buildCommand), requirements]));
  } else throw new DockpackError(`Unsupported build command runtime: ${ecosystem}.`);
}

function makePortableBindMounts(model: { services?: Record<string, Record<string, unknown>> }, projectRoot: string, findings: string[]): void {
  for (const [serviceName, service] of Object.entries(model.services ?? {})) {
    if (!Array.isArray(service.volumes)) continue;
    service.volumes = service.volumes.map((volume) => {
      if (!volume || typeof volume !== "object") return volume;
      const mount = volume as { type?: string; source?: string; target?: string };
      if (mount.type !== "bind" || !mount.source) return volume;
      const absoluteSource = path.isAbsolute(mount.source) ? mount.source : path.resolve(projectRoot, mount.source);
      const relative = path.relative(projectRoot, absoluteSource);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new DockpackError(`Compose service '${serviceName}' bind mount '${mount.source}' is outside the project directory and cannot be made portable automatically.`);
      }
      mount.source = path.posix.join("..", "runtime", ...relative.split(path.sep));
      findings.push(`Bind mount '${serviceName}:${mount.target ?? ""}' maps to an empty portable runtime directory on the target host.`);
      return mount;
    });
  }
}

function protectProductionEnvironment(model: ComposeModel, requiredConfig: Set<string>, findings: string[]): void {
  for (const [name, service] of Object.entries(model.services)) {
    let environment = service.environment;
    if (Array.isArray(environment)) {
      environment = Object.fromEntries(environment.map((entry: unknown) => {
        const text = String(entry);
        const separator = text.indexOf("=");
        return separator < 0 ? [text, null] : [text.slice(0, separator), text.slice(separator + 1)];
      }));
      service.environment = environment;
    }
    if (!environment || typeof environment !== "object") continue;
    for (const [key, value] of Object.entries(environment)) {
      if (!/(password|secret|token|api[_-]?key|private[_-]?key)/i.test(key)) continue;
      // Preserve variable aliases but remove embedded default secret values.
      const source = typeof value === "string"
        ? value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::[-+?]|[-+?])[\s\S]*)?\}$/)
          ?? value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
        : null;
      const variable = source?.[1] ?? key;
      const replacement = `\${${variable}}`;
      (environment as Record<string, unknown>)[key] = replacement;
      requiredConfig.add(variable);
      if (value !== replacement) findings.push(`Sensitive environment value '${key}' for '${name}' was replaced with a production variable.`);
    }
  }
}

export async function buildProductionBundle(projectDir: string, outputPath?: string, developmentBundle?: string): Promise<string> {
  const totalStarted = Date.now();
  const root = path.resolve(projectDir);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  if (config.target.production_platform !== TARGET) throw new DockpackError(`Only ${TARGET} production bundles are supported in this release.`);
  const docker = new DockerRunner();
  if (!docker.available()) throw new DockpackError("Docker CLI and daemon are required to build production bundles.");
  const daemon = docker.platform();
  if (daemon.os !== "linux") throw new DockpackError("Production builds require a Docker daemon capable of running Linux containers.");
  const buildEnvironment = docker.buildEnvironment();
  logger.info(`[dockpack] Production Docker builder: ${buildEnvironment.BUILDX_BUILDER} (docker driver)`);
  const output = path.resolve(outputPath ?? defaultProductionBundlePath(root, config.target.production_platform));
  const resourcePlatform = config.target.dev_platform === "auto" ? daemon.id : config.target.dev_platform;
  const bundlePath = path.resolve(developmentBundle ?? defaultDevelopmentBundlePath(root, resourcePlatform));
  if (output === bundlePath) throw new DockpackError("Production output must not overwrite the development resource bundle. Choose a different --output path.");
  const workDir = await mkdtemp(path.join(os.tmpdir(), "dockpack-prod-build-"));
  const stage = path.join(workDir, "payload");
  try {
    await mkdir(stage);
    const bundleRoot = await prepareProductionResources(root, bundlePath, path.join(workDir, "resources"), docker, TARGET);
    logger.info(`[dockpack] Production target platform: ${TARGET}`);
    logger.info(`[dockpack] Production bundle output: ${output}`);

    const composeAnalysis = await analyzeCompose(root, config.compose.files);
    const hasCompose = composeAnalysis.files.length > 0;
    const appService = config.application.service;
    const generatedImage = appImageName(config.project.name, appService);
    const findings: string[] = [];
    const requiredConfig = new Set<string>();
    const persistentVolumes = new Set<string>();
    const composeDir = path.join(stage, "compose");
    await mkdir(composeDir, { recursive: true });
    const overridePath = path.join(composeDir, "dockpack-build.override.yaml");
    const normalizedPath = path.join(composeDir, "compose.yaml");

    if (!hasCompose) {
      const staticFrontend = await buildGeneratedApplication(root, stage, generatedImage, path.join(bundleRoot, "cache"), docker, config);
      const hostPort = config.application.port ?? (staticFrontend ? 80 : null);
      const portMap = hostPort ? [`${hostPort}:${staticFrontend ? 80 : hostPort}`] : [];
      const composeModel = { services: { [appService]: { image: generatedImage, ports: portMap } } };
      const images = await productionStep("Exporting production images", () => exportProductionImages(composeModel, docker, stage, TARGET));
      await writeFile(normalizedPath, stringify(composeModel), "utf8");
      const manifest = makeManifest({
        bundle_kind: "prod", dockpack_version: VERSION, project_name: config.project.name,
        target_platform: TARGET, images, dependencies: {}, services: [appService],
        required_config: [...requiredConfig], persistent_volumes: [], findings,
      });
      await productionStep("Writing production bundle archive", () => createArchive(stage, output, manifest));
      return output;
    }

    const raw = await readFile(composeAnalysis.files[0]!, "utf8");
    const referencedEnv = [...raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::-|[-+?])[^}]*)?\}/g)]
      .filter((match) => !match[0].includes(":-") && !/\$\{[A-Za-z_][A-Za-z0-9_]*-[^}]*\}/.test(match[0]))
      .map((match) => match[1]).filter((item): item is string => Boolean(item));
    for (const key of referencedEnv) requiredConfig.add(key);
    const command = getComposeCommand();
    if (!command) throw new DockpackError("Docker Compose is required to resolve project services for production packaging.");
    const composeModel = await resolveComposeModel(root, composeAnalysis.files, config.compose.profiles);
    const services = composeModel.services ?? {};
    for (const [name, volume] of Object.entries(composeModel.volumes ?? {})) {
      if (volume.external !== true) persistentVolumes.add(name);
      else findings.push(`Volume '${name}' is external and must exist on the production host.`);
    }
    for (const [name, network] of Object.entries(composeModel.networks ?? {})) {
      if (network.external === true) findings.push(`Network '${name}' is external and must exist on the production host.`);
    }
    const overrideServices: Record<string, Record<string, unknown>> = {};
    const appAlreadyConfigured = Boolean(services[appService]?.image || services[appService]?.build);
    const rootDockerfile = path.join(root, "Dockerfile");
    const appUsesExistingDockerfile = Boolean(services[appService]?.image && !services[appService]?.build && existsSync(rootDockerfile));
    const appNeedsGenerated = !appAlreadyConfigured || needsGeneratedDockerfile(root, services[appService]) || appUsesExistingDockerfile;
    if (appNeedsGenerated) {
      if (appUsesExistingDockerfile) {
        const ecosystem = config.project.ecosystems[0];
        if (!ecosystem) throw new DockpackError("No project runtime is configured for application.build_command.");
        const workspace = path.join(workDir, "application-workspace");
        await runProjectBuildCommand(root, workspace, path.join(bundleRoot, "cache"), docker, ecosystem, config.application.build_command);
        await validateOfflineBuild(appService, workspace, { context: ".", dockerfile: "Dockerfile" });
        const image = String(services[appService]?.image || generatedImage);
        overrideServices[appService] = { image, build: { context: workspace, dockerfile: "Dockerfile", network: "none" } };
        if (command.prefix[0] === "docker") overrideServices[appService].platform = TARGET;
      } else {
        const staticFrontend = await buildGeneratedApplication(root, stage, generatedImage, path.join(bundleRoot, "cache"), docker, config);
        overrideServices[appService] = { image: generatedImage, build: null };
        if (command.prefix[0] === "docker") overrideServices[appService].platform = TARGET;
        if (config.application.port) overrideServices[appService].ports = [`${config.application.port}:${staticFrontend ? 80 : config.application.port}`];
        else if (staticFrontend && (!Array.isArray(services[appService]?.ports) || services[appService]?.ports.length === 0)) overrideServices[appService].ports = ["80:80"];
      }
    }

    for (const [name, service] of Object.entries(services)) {
      if (config.compose.exclude_services.includes(name)) continue;
      if (name === appService && appNeedsGenerated) continue;
      const override: Record<string, unknown> = {};
      if (command.prefix[0] === "docker") override.platform = TARGET;
      if (service.build) {
        if (name !== appService || !appNeedsGenerated) await validateOfflineBuild(name, root, service.build);
        const build = typeof service.build === "object" ? service.build as Record<string, unknown> : {};
        override.build = { ...build, network: "none" };
        if (typeof service.image === "string") override.image = service.image;
        else override.image = appImageName(config.project.name, name);
        overrideServices[name] = { ...overrideServices[name], ...override };
      } else if (name !== appService || appAlreadyConfigured) {
        if (typeof service.image !== "string" || service.image.includes("${")) {
          findings.push(`Service '${name}' has an unresolved or missing image and cannot be bundled.`);
          continue;
        }
        if (!docker.hasImage(service.image)) throw new DockpackError(`Image ${service.image} for service '${name}' is not present locally. The production builder does not pull images.`);
        const platform = docker.imagePlatform(service.image);
        if (platform !== TARGET) throw new DockpackError(`Image ${service.image} for '${name}' is ${platform}; ${TARGET} is required.`);
      }
      if (service.network_mode === "host") findings.push(`Service '${name}' uses host networking and may not be portable.`);
      if (Array.isArray(service.devices) && service.devices.length) findings.push(`Service '${name}' maps host devices and needs target-specific configuration.`);
      if (Array.isArray(service.secrets) && service.secrets.length) findings.push(`Service '${name}' references secrets; provide secret files on the production host.`);
      if (service.env_file) findings.push(`Service '${name}' uses env_file; create the required production-side file before deployment.`);
      if (Array.isArray(service.volumes)) {
        for (const volume of service.volumes) {
          if (volume && typeof volume === "object") {
            const entry = volume as { type?: string; source?: string; target?: string };
            if (entry.type === "bind") findings.push(`Service '${name}' bind mount to '${entry.target ?? ""}' will use an empty bundle-local runtime directory; existing host data is not included.`);
            if (entry.type === "volume" && entry.source) persistentVolumes.add(entry.source);
          } else if (typeof volume === "string") {
            const source = volume.split(":")[0] ?? "";
            if (source.startsWith(".") || source.startsWith("/")) findings.push(`Service '${name}' has a host bind mount; its target path must be validated for portability.`);
          }
        }
      }
    }

    let deploymentModel = composeModel;
    if (Object.keys(overrideServices).length) {
      await writeFile(overridePath, stringify({ services: overrideServices }), "utf8");
      const buildArgs = composePrefix(composeAnalysis.files, overridePath);
      const servicesToBuild = Object.keys(overrideServices).filter((name) => Boolean(overrideServices[name]?.build)
        && !(name === appService && appNeedsGenerated && !appUsesExistingDockerfile));
      if (servicesToBuild.length) await productionStep("Building Compose production services", () => runCompose([...buildArgs, "build", "--pull=false", ...servicesToBuild], root, docker.buildEnvironment(), { streamOutput: true }));
      const normalized = await resolveComposeModel(root, [...composeAnalysis.files, overridePath], config.compose.profiles);
      deploymentModel = normalized;
      if (normalized.volumes) {
        for (const [name, value] of Object.entries(normalized.volumes)) {
          if ((value as { external?: boolean }).external !== true) persistentVolumes.add(name);
          else findings.push(`Volume '${name}' is external and must exist on the production host.`);
        }
      }
      if (normalized.networks) {
        for (const [name, value] of Object.entries(normalized.networks)) {
          if ((value as { external?: boolean }).external === true) findings.push(`Network '${name}' is external and must exist on the production host.`);
        }
      }
    }
    await rm(overridePath, { force: true });
    for (const [name, service] of Object.entries(deploymentModel.services)) {
      if (config.compose.exclude_services.includes(name)) {
        delete deploymentModel.services[name];
        continue;
      }
      delete service.build;
      delete service.platform;
    }
    // Apply protection to the final resolved model, after all build overrides.
    protectProductionEnvironment(deploymentModel, requiredConfig, findings);
    makePortableBindMounts(deploymentModel, root, findings);
    const images = await productionStep("Exporting production images", () => exportProductionImages(deploymentModel, docker, stage, TARGET));
    await writeFile(normalizedPath, stringify(deploymentModel), "utf8");

    for (const finding of findings) logger.warn(`dockpack: warning: ${finding}`);
    const example = [...requiredConfig].sort().map((key) => `${key}=`).join("\n");
    if (example) {
      await writeFile(path.join(composeDir, ".env.example"), `${example}\n`, "utf8");
      await writeFile(path.join(stage, ".env.example"), `${example}\n`, "utf8");
    }
    await writeFile(path.join(composeDir, "README.md"), [
      `# ${config.project.name} production bundle`,
      "",
      `Target platform: ${TARGET}`,
      "",
      "Import bundled images and start the Compose stack with Dockpack. Provide values listed in .env.example on the target host.",
      "Database data is stored in Docker volumes and is not included in this bundle.",
      ...findings.map((finding) => `- Review: ${finding}`),
      "",
    ].join("\n"), "utf8");
    const manifest = makeManifest({
      bundle_kind: "prod", dockpack_version: VERSION, project_name: config.project.name,
      target_platform: TARGET, images, dependencies: {},
      services: Object.keys(deploymentModel.services),
      findings, required_config: [...requiredConfig], persistent_volumes: [...persistentVolumes],
    });
    await productionStep("Writing production bundle archive", () => createArchive(stage, output, manifest));
    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
    logger.info(`[dockpack] Production build elapsed: ${((Date.now() - totalStarted) / 1000).toFixed(1)}s`);
  }
}
