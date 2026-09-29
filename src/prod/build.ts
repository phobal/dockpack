import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { createArchive } from "../bundles/archive.js";
import { makeManifest } from "../bundles/manifest.js";
import { getComposeCommand, runCompose } from "../compose/command.js";
import { analyzeCompose, resolveComposeModel } from "../compose/inspect.js";
import { readConfig } from "../config/io.js";
import { DockerRunner } from "../docker/runner.js";
import { DockpackError } from "../errors.js";
import { detectProject } from "../project/detect.js";

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

async function prepareContext(root: string, context: string): Promise<void> {
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
      if (/^\.env(?:\..*)?$/.test(name) && name !== ".env.example") return false;
      if ([".npmrc", ".pypirc", ".netrc"].includes(name)) return false;
      if (/\.(pem|key|p12|pfx)$/i.test(name)) return false;
      return true;
    },
  });
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

async function buildGeneratedApplication(root: string, stage: string, image: string, cacheDir: string, docker: DockerRunner, config: Awaited<ReturnType<typeof readConfig>>): Promise<void> {
  if (docker.platform().os !== "linux") throw new DockpackError("Production image creation requires a Docker daemon capable of building Linux containers.");
  const detections = await detectProject(root);
  if (detections.length !== 1) throw new DockpackError("Automatic production Dockerfile generation currently supports one application runtime per project.");
  const detection = detections[0]!;
  const file = lockFile(detection);
  const command = config.application.command;
  if (command.length === 0) throw new DockpackError("Set application.command in .dockpack.yaml; Dockpack could not safely infer how to start this project.");
  const runtime = (await import("../dev/dependencies.js")).runtimeImage(detection, root);
  const baseImage = await runtime;
  if (!docker.hasImage(baseImage)) throw new DockpackError(`Required base image ${baseImage} is not present locally. Prepare it in the development bundle before going offline.`);
  const basePlatform = docker.imagePlatform(baseImage);
  if (basePlatform !== TARGET) throw new DockpackError(`Base image ${baseImage} is ${basePlatform}; production build needs ${TARGET}.`);
  const context = path.join(stage, "build-context");
  await mkdir(context, { recursive: true });
  await prepareContext(root, context);
  const dockerfile = path.join(context, "Dockerfile.dockpack");
  let hasBuildScript = false;
  if (detection.ecosystem === "node") {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    hasBuildScript = Boolean(packageJson.scripts?.build);
  }
  await writeFile(dockerfile, dockerfileFor(detection.ecosystem, baseImage, file, command, hasBuildScript), "utf8");
  await writeFile(path.join(context, ".dockerignore"), "Dockerfile.dockpack\n", "utf8");
  docker.run([
    "buildx", "build", "--pull=false", "--platform", TARGET, "--load", "--tag", image,
    "--file", dockerfile, "--build-context", `dockpack-cache=${cacheDir}`, context,
  ]);
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

export async function buildProductionBundle(projectDir: string, outputPath: string): Promise<void> {
  const root = path.resolve(projectDir);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  if (config.target.production_platform !== TARGET) throw new DockpackError(`Only ${TARGET} production bundles are supported in this release.`);
  const docker = new DockerRunner();
  if (!docker.available()) throw new DockpackError("Docker CLI and daemon are required to build production bundles.");
  const stage = await mkdtemp(path.join(os.tmpdir(), "dockpack-prod-stage-"));
  try {
    const stateFile = path.join(root, ".dockpack", "state.json");
    let bundleRoot: string | undefined;
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as { bundle_root?: string };
      bundleRoot = state.bundle_root;
    } catch {
      throw new DockpackError("Production building requires an imported development bundle and initialized .dockpack project state.");
    }
    if (!bundleRoot) throw new DockpackError("Development bundle cache location is missing from .dockpack/state.json.");

    const composeAnalysis = await analyzeCompose(root, config.compose.files);
    const hasCompose = composeAnalysis.files.length > 0;
    const appService = config.application.service;
    const generatedImage = appImageName(config.project.name, appService);
    const images = new Set<string>();
    const findings: string[] = [];
    const requiredConfig = new Set<string>();
    const persistentVolumes = new Set<string>();
    const composeDir = path.join(stage, "compose");
    await mkdir(composeDir, { recursive: true });
    const overridePath = path.join(composeDir, "dockpack-build.override.yaml");
    const normalizedPath = path.join(composeDir, "compose.yaml");

    if (!hasCompose) {
      await buildGeneratedApplication(root, stage, generatedImage, path.join(bundleRoot, "cache"), docker, config);
      images.add(generatedImage);
      const portMap = config.application.port ? [`${config.application.port}:${config.application.port}`] : [];
      const composeModel = { services: { [appService]: { image: generatedImage, ports: portMap } } };
      await writeFile(normalizedPath, stringify(composeModel), "utf8");
      await mkdir(path.join(stage, "images"), { recursive: true });
      docker.save([...images], path.join(stage, "images", "images.tar"));
      const manifest = makeManifest({
        bundle_kind: "prod", dockpack_version: "0.1.0", project_name: config.project.name,
        target_platform: TARGET, images: [...images], dependencies: {}, services: [appService],
        required_config: [...requiredConfig], persistent_volumes: [], findings,
      });
      await createArchive(stage, outputPath, manifest);
      return;
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
    const appNeedsGenerated = !appAlreadyConfigured || needsGeneratedDockerfile(root, services[appService]);
    if (appNeedsGenerated) {
      await buildGeneratedApplication(root, stage, generatedImage, path.join(bundleRoot, "cache"), docker, config);
      images.add(generatedImage);
      overrideServices[appService] = { image: generatedImage, build: null };
      if (command.prefix[0] === "docker") overrideServices[appService].platform = TARGET;
      if (config.application.port) overrideServices[appService].ports = [`${config.application.port}:${config.application.port}`];
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
      const image = (overrideServices[name]?.image ?? service.image) as string | undefined;
      if (image) images.add(image);
      if (service.network_mode === "host") findings.push(`Service '${name}' uses host networking and may not be portable.`);
      if (Array.isArray(service.devices) && service.devices.length) findings.push(`Service '${name}' maps host devices and needs target-specific configuration.`);
      if (Array.isArray(service.secrets) && service.secrets.length) findings.push(`Service '${name}' references secrets; provide secret files on the production host.`);
      if (service.env_file) findings.push(`Service '${name}' uses env_file; create the required production-side file before deployment.`);
      const environment = service.environment;
      if (environment && !Array.isArray(environment) && typeof environment === "object") {
        const entries = environment as Record<string, unknown>;
        for (const key of Object.keys(entries)) {
          if (/(password|secret|token|api[_-]?key|private[_-]?key)/i.test(key) && typeof entries[key] === "string" && !String(entries[key]).includes("${")) {
            entries[key] = `\${${key}}`;
            requiredConfig.add(key);
            findings.push(`Sensitive environment value '${key}' for '${name}' was replaced with a production variable.`);
          }
        }
      }
      if (Array.isArray(service.volumes)) {
        for (const volume of service.volumes) {
          if (volume && typeof volume === "object") {
            const entry = volume as { type?: string; source?: string; target?: string };
            if (entry.type === "bind") findings.push(`Service '${name}' has bind mount '${entry.source ?? ""}:${entry.target ?? ""}'; verify the path exists on the production host.`);
            if (entry.type === "volume" && entry.source) persistentVolumes.add(entry.source);
          } else if (typeof volume === "string") {
            const source = volume.split(":")[0] ?? "";
            if (source.startsWith(".") || source.startsWith("/")) findings.push(`Service '${name}' has host bind mount '${volume}'; verify the path exists on the production host.`);
          }
        }
      }
    }

    if (Object.keys(overrideServices).length) {
      await writeFile(overridePath, stringify({ services: overrideServices }), "utf8");
      const buildArgs = composePrefix(composeAnalysis.files, overridePath);
      runCompose(command.prefix, [...buildArgs, "build", "--pull=false", ...Object.keys(overrideServices).filter((name) => services[name]?.build && !(name === appService && appNeedsGenerated))], root);
      const normalized = await resolveComposeModel(root, [...composeAnalysis.files, overridePath], config.compose.profiles);
      for (const [name, service] of Object.entries(normalized.services ?? {})) {
        if (config.compose.exclude_services.includes(name)) {
          delete normalized.services[name];
          continue;
        }
        delete service.build;
        delete service.platform;
        delete service.pull_policy;
        const image = service.image;
        if (typeof image === "string") {
          if (!docker.hasImage(image)) throw new DockpackError(`Image ${image} for '${name}' was not built or loaded.`);
          if (docker.imagePlatform(image) !== TARGET) throw new DockpackError(`Image ${image} for '${name}' is not ${TARGET}.`);
          images.add(image);
        }
      }
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
      await writeFile(normalizedPath, stringify(normalized), "utf8");
    } else {
      for (const [name, service] of Object.entries(composeModel.services)) {
        if (config.compose.exclude_services.includes(name)) {
          delete composeModel.services[name];
          continue;
        }
        delete service.build;
        delete service.platform;
        delete service.pull_policy;
        const image = service.image;
        if (typeof image === "string" && !config.compose.exclude_services.includes(name)) images.add(image);
      }
      await writeFile(normalizedPath, stringify(composeModel), "utf8");
    }
    await rm(overridePath, { force: true });

    for (const finding of findings) console.warn(`dockpack: warning: ${finding}`);
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
    await mkdir(path.join(stage, "images"), { recursive: true });
    docker.save([...images], path.join(stage, "images", "images.tar"));
    const manifest = makeManifest({
      bundle_kind: "prod", dockpack_version: "0.1.0", project_name: config.project.name,
      target_platform: TARGET, images: [...images], dependencies: {},
      services: Object.keys(services).filter((name) => !config.compose.exclude_services.includes(name)),
      findings, required_config: [...requiredConfig], persistent_volumes: [...persistentVolumes],
    });
    await createArchive(stage, outputPath, manifest);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
