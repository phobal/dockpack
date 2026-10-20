import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeCompose } from "../compose/inspect.js";
import { getComposeCommand, runCompose } from "../compose/command.js";
import { readConfig } from "../config/io.js";
import { DockpackError } from "../errors.js";
import { createArchive } from "../bundles/archive.js";
import { makeManifest } from "../bundles/manifest.js";
import { DockerRunner } from "../docker/runner.js";
import { detectProject } from "../project/detect.js";
import { stringify } from "yaml";
import { collectNpm, collectPython, runtimeImage, type CollectedDependency } from "./dependencies.js";

function elapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

async function progress<T>(label: string, action: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  console.log(`\n[dockpack] ${label}...`);
  try {
    const result = await action();
    console.log(`[dockpack] ✓ ${label} (${elapsed(Date.now() - started)})`);
    return result;
  } catch (error) {
    console.error(`[dockpack] ✗ ${label} (${elapsed(Date.now() - started)})`);
    throw error;
  }
}

async function dockerfileBaseImages(filename: string): Promise<string[]> {
  if (!existsSync(filename)) return [];
  const argumentsByName = new Map<string, string>();
  const result = new Set<string>();
  for (const line of (await readFile(filename, "utf8")).split(/\r?\n/)) {
    const arg = line.match(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/);
    if (arg?.[1] && arg[2]) argumentsByName.set(arg[1], arg[2].replace(/^['"]|['"]$/g, ""));
    const from = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)/i);
    if (!from?.[1]) continue;
    const image = from[1].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_whole, braced: string | undefined, plain: string | undefined) => argumentsByName.get(braced ?? plain ?? "") ?? "");
    if (image && !image.includes("$") && image.toLowerCase() !== "scratch") result.add(image);
  }
  return [...result];
}

export async function createDevelopmentBundle(projectDir: string, outputPath: string): Promise<void> {
  const root = path.resolve(projectDir);
  const totalStarted = Date.now();
  const docker = new DockerRunner();
  console.log(`[dockpack] Creating development bundle for ${root}`);
  const { config, platform, detections, compose } = await progress("Checking project configuration and Docker", async () => {
    const config = await readConfig(path.join(root, ".dockpack.yaml"));
    if (!docker.available()) throw new DockpackError("Docker CLI and a running daemon are required to create a development bundle.");
    const platform = docker.platform().id;
    const detections = await detectProject(root);
    if (detections.length === 0) throw new DockpackError("No supported Python or Node.js dependency files were detected.");
    for (const item of detections) {
      if (item.ecosystem === "python" && item.packageManager !== "pip") {
        throw new DockpackError(`Python package manager '${item.packageManager ?? "unknown"}' is detected but this build supports pip requirements files only.`);
      }
      if (item.ecosystem === "node" && item.packageManager !== "npm") {
        throw new DockpackError(`Node.js package manager '${item.packageManager ?? "unknown"}' is detected but this build supports npm package-lock.json only.`);
      }
    }
    const compose = await analyzeCompose(root, config.compose.files, config.compose.profiles);
    return { config, platform, detections, compose };
  });
  const stage = await mkdtemp(path.join(os.tmpdir(), "dockpack-dev-stage-"));
  try {
    const cacheDir = path.join(stage, "cache");
    const imagesDir = path.join(stage, "images");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    const dependencies: CollectedDependency[] = [];
    const images = new Set<string>();
    for (const detection of detections) {
      const image = await runtimeImage(detection, root);
      await progress(`Pulling ${detection.ecosystem} runtime image ${image}`, () => docker.pull(image, platform, true));
      images.add(image);
      const dependency = await progress(`Collecting ${detection.ecosystem} offline dependencies`, () => detection.ecosystem === "python"
        ? collectPython(root, cacheDir, image, docker)
        : collectNpm(root, cacheDir, image, docker));
      dependencies.push(dependency);
    }

    // Production images may use a different base architecture than this
    // development host. Cache project Dockerfile bases for the amd64 build.
    for (const baseImage of await dockerfileBaseImages(path.join(root, "Dockerfile"))) {
      await progress(`Pulling Dockerfile base image ${baseImage} (linux/amd64)`, () => docker.pull(baseImage, "linux/amd64", true));
      images.add(baseImage);
    }

    const infrastructure = compose.services.filter((service) => service.name !== config.application.service
      && !config.compose.exclude_services.includes(service.name));
    const buildServices = infrastructure.filter((service) => service.build);
    if (buildServices.length > 0) {
      const composeCommand = getComposeCommand();
      if (!composeCommand) throw new DockpackError("Docker Compose is required to build Compose infrastructure services.");
      const overrideServices: Record<string, Record<string, unknown>> = {};
      for (const service of buildServices) {
        const slug = `${config.project.name}-${service.name}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
        const tag = typeof service.image === "string" ? service.image : `dockpack/${slug}:offline`;
        overrideServices[service.name] = {
          image: tag,
          build: { ...(typeof service.build === "object" ? service.build as Record<string, unknown> : {}), network: "default" },
        };
        images.add(tag);
      }
      const overrideFile = path.join(stage, "compose-build.override.yaml");
      await (await import("node:fs/promises")).writeFile(overrideFile, stringify({ services: overrideServices }), "utf8");
      const composeArgs: string[] = [];
      for (const file of compose.files) composeArgs.push("-f", file);
      composeArgs.push("-f", overrideFile);
      if (composeCommand.prefix[0] === "docker") for (const profile of config.compose.profiles) composeArgs.push("--profile", profile);
      await progress(`Building Compose services: ${buildServices.map((service) => service.name).join(", ")}`, () =>
        runCompose([...composeArgs, "build", ...buildServices.map((service) => service.name)], root, process.env, { streamOutput: true }));
      await (await import("node:fs/promises")).rm(overrideFile, { force: true });
    }
    for (const service of infrastructure) {
      if (service.build) continue;
      if (!service.image) throw new DockpackError(`Compose service '${service.name}' has neither a build image nor image reference.`);
      const image = service.image;
      const cachedForPlatform = docker.hasImage(image) && docker.imagePlatform(image) === platform;
      if (cachedForPlatform) {
        console.log(`[dockpack] Using cached Compose service image ${service.name}: ${image} (${platform}).`);
      } else {
        await progress(`Pulling Compose service image ${service.name}: ${image}`, () => {
          try {
            docker.pull(image, platform, true);
          } catch (error) {
            const cachedPlatform = docker.hasImage(image) ? docker.imagePlatform(image) : undefined;
            if (cachedPlatform === platform) {
              console.warn(`[dockpack] Pull failed, using cached ${platform} image ${image}.`);
              return;
            }
            const reason = error instanceof Error ? error.message : String(error);
            throw new DockpackError(
              `Cannot package Compose service '${service.name}' image '${image}' for ${platform}. ` +
              `Check that the image reference is valid and accessible, or load a matching image into Docker first. ${reason}`,
              { cause: error },
            );
          }
        });
      }
      images.add(service.image);
    }
    if (images.size > 0) {
      await progress(`Exporting ${images.size} Docker images`, () => docker.save([...images], path.join(imagesDir, "images.tar"), true));
    }

    const manifest = makeManifest({
      bundle_kind: "dev",
      dockpack_version: "0.1.0",
      project_name: config.project.name,
      target_platform: platform,
      images: [...images],
      dependencies: Object.fromEntries(dependencies.map((item) => [item.ecosystem, item.lockDigest])),
      services: infrastructure.map((service) => service.name),
    });
    await progress(`Writing bundle archive ${path.resolve(outputPath)}`, () => createArchive(stage, outputPath, manifest));
    console.log(`[dockpack] Development bundle completed in ${elapsed(Date.now() - totalStarted)}.`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
