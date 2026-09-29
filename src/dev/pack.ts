import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

export async function createDevelopmentBundle(projectDir: string, outputPath: string): Promise<void> {
  const root = path.resolve(projectDir);
  const config = await readConfig(path.join(root, ".dockpack.yaml"));
  const docker = new DockerRunner();
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
      docker.pull(image, platform);
      images.add(image);
      const dependency = detection.ecosystem === "python"
        ? await collectPython(root, cacheDir, image, docker)
        : await collectNpm(root, cacheDir, image, docker);
      dependencies.push(dependency);
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
      runCompose(composeCommand.prefix, [...composeArgs, "build", ...buildServices.map((service) => service.name)], root);
      await (await import("node:fs/promises")).rm(overrideFile, { force: true });
    }
    for (const service of infrastructure) {
      if (service.build) continue;
      if (!service.image) throw new DockpackError(`Compose service '${service.name}' has neither a build image nor image reference.`);
      docker.pull(service.image, platform);
      images.add(service.image);
    }
    if (images.size > 0) docker.save([...images], path.join(imagesDir, "images.tar"));

    const manifest = makeManifest({
      bundle_kind: "dev",
      dockpack_version: "0.1.0",
      project_name: config.project.name,
      target_platform: platform,
      images: [...images],
      dependencies: Object.fromEntries(dependencies.map((item) => [item.ecosystem, item.lockDigest])),
      services: infrastructure.map((service) => service.name),
    });
    await createArchive(stage, outputPath, manifest);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
