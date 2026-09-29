#!/usr/bin/env node
import { Command } from "commander";
import { inspectArchive } from "./bundles/archive.js";
import { bundleFingerprint, extractArchive } from "./bundles/archive.js";
import { initializeProject } from "./commands/init.js";
import { DockpackError } from "./errors.js";
import { createDevelopmentBundle } from "./dev/pack.js";
import { execDev, initializeDevProject, rebuildDev, startDev, stopDev } from "./dev/project.js";
import { DockerRunner } from "./docker/runner.js";
import { mkdir, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProductionBundle } from "./prod/build.js";
import { backupProduction, downProduction, importProductionBundle, logsProduction, restoreProduction, statusProduction, upProduction } from "./prod/deploy.js";

const program = new Command();
program.name("dockpack").description("Prepare projects for offline Docker development and deployment").version("0.1.0");

program.command("init")
  .description("Analyze a project and create .dockpack.yaml")
  .argument("[project-directory]", "project root", ".")
  .action(async (projectDirectory: string) => {
    const result = await initializeProject(projectDirectory);
    console.log(`${result.created ? "Created" : "Found existing configuration; preserved it"}: ${result.configPath}`);
    console.log(`Project: ${result.config.project.name} (${result.config.project.ecosystems.join(", ") || "not detected"})`);
    console.log(`Compose services: ${result.services.join(", ") || "none detected"}`);
    if (result.findings.length) {
      console.log("Review findings:");
      for (const finding of result.findings) console.log(`  - ${finding}`);
    }
  });

const pack = program.command("pack").description("Create and inspect offline bundles");
pack.command("dev")
  .description("Create an offline development bundle on a connected machine")
  .argument("[project-directory]", "project root", ".")
  .requiredOption("-o, --output <path>", "output archive path")
  .action(async (projectDirectory: string, options: { output: string }) => {
    await createDevelopmentBundle(projectDirectory, options.output);
    console.log(`Created development bundle: ${options.output}`);
  });
pack.command("inspect")
  .description("Verify and summarize an offline bundle")
  .argument("<bundle>")
  .action(async (bundle: string) => printManifest(bundle));

program.command("import")
  .description("Verify and import images from an offline bundle")
  .argument("<bundle>")
  .action(async (bundle: string) => {
    const docker = new DockerRunner();
    if (!docker.available()) throw new DockpackError("Docker CLI and daemon are required to import a bundle.");
    const root = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "dockpack", "bundles", await bundleFingerprint(bundle));
    await mkdir(path.dirname(root), { recursive: true });
    await rm(root, { recursive: true, force: true });
    const extracted = await extractArchive(bundle, root);
    const manifest = await inspectArchive(bundle);
    if (manifest.target_platform !== docker.platform().id) throw new DockpackError(`Bundle targets ${manifest.target_platform}; Docker daemon uses ${docker.platform().id}.`);
    for (const file of await readdir(path.join(extracted, "images"))) if (file.endsWith(".tar")) docker.load(path.join(extracted, "images", file));
    console.log(`Imported ${manifest.bundle_kind} bundle ${manifest.project_name} to ${extracted}`);
  });

const dev = program.command("dev").description("Manage an offline development environment");
dev.command("init")
  .description("Attach an offline bundle to the original project directory")
  .argument("[project-directory]", "project root", ".")
  .requiredOption("--bundle <path>", "development bundle")
  .action(async (projectDirectory: string, options: { bundle: string }) => {
    await initializeDevProject(projectDirectory, options.bundle);
    console.log(`Initialized development environment in ${projectDirectory}`);
  });
dev.command("start").argument("[project-directory]", "project root", ".").action(startDev);
dev.command("stop").argument("[project-directory]", "project root", ".").action(stopDev);
dev.command("rebuild").argument("[project-directory]", "project root", ".").action(rebuildDev);
dev.command("exec")
  .description("Run a command inside the development container")
  .argument("[project-directory]", "project root", ".")
  .argument("<command...>", "command after --")
  .allowUnknownOption(true)
  .action(execDev);

const build = program.command("build").description("Build offline deployment bundles");
build.command("prod").argument("[project-directory]", "project root", ".").requiredOption("-o, --output <path>")
  .action(async (projectDirectory: string, options: { output: string }) => {
    await buildProductionBundle(projectDirectory, options.output);
    console.log(`Created production bundle: ${options.output}`);
  });

const prod = program.command("prod").description("Inspect production bundles");
prod.command("inspect").argument("<bundle>").action(async (bundle: string) => printManifest(bundle));

const deploy = program.command("deploy").description("Manage offline production deployments");
for (const action of ["import", "up", "down", "status", "logs", "backup", "restore"]) {
  const command = deploy.command(action).argument("<bundle>");
  if (action === "logs") {
    command.argument("[service]").action(async (bundle: string, service?: string) => logsProduction(bundle, service));
  } else if (action === "backup") {
    command.option("-o, --output <path>").action(async (bundle: string, options: { output?: string }) => {
      console.log(`Created backup: ${await backupProduction(bundle, options.output)}`);
    });
  } else if (action === "restore") {
    command.requiredOption("--backup <path>").option("--overwrite", "replace existing volume contents").action(
      async (bundle: string, options: { backup: string; overwrite?: boolean }) => restoreProduction(bundle, options.backup, Boolean(options.overwrite)),
    );
  } else {
    command.action(async (bundle: string) => {
      if (action === "import") return importProductionBundle(bundle);
      if (action === "up") return upProduction(bundle);
      if (action === "down") return downProduction(bundle);
      return statusProduction(bundle);
    });
  }
}

async function printManifest(bundlePath: string): Promise<void> {
  const manifest = await inspectArchive(bundlePath);
  console.log(`Bundle kind: ${manifest.bundle_kind}`);
  console.log(`Project: ${manifest.project_name}`);
  console.log(`Target: ${manifest.target_platform}`);
  console.log(`Images: ${manifest.images.join(", ") || "none"}`);
  console.log(`Services: ${manifest.services.join(", ") || "none"}`);
  console.log(`Dependencies: ${JSON.stringify(manifest.dependencies)}`);
  console.log(`Payload members: ${manifest.members.length}`);
}

program.showHelpAfterError();
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`dockpack: error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
