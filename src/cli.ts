#!/usr/bin/env node
import { logger } from "./logger.js";
import chalk, { chalkStderr } from "chalk";
import { Command } from "commander";
import { VERSION } from "./version.js";
import { inspectArchive } from "./bundles/archive.js";
import { bundleCachePath, bundleFingerprint, extractArchive } from "./bundles/archive.js";
import { initializeProject } from "./commands/init.js";
import { DockpackError } from "./errors.js";
import { createDevelopmentBundle } from "./dev/pack.js";
import { execDev, initializeDevProject, rebuildDev, startDev, stopDev } from "./dev/project.js";
import { DockerRunner } from "./docker/runner.js";
import { mkdir, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { buildProductionBundle } from "./prod/build.js";
import { backupProduction, downProduction, importProductionBundle, logsProduction, restoreProduction, statusProduction, upProduction } from "./prod/deploy.js";

const program = new Command();
program.name("dockpack").description("Prepare projects for offline Docker development and deployment").version(VERSION);
program.configureOutput({
  writeOut: (message) => { process.stdout.write(chalk.cyan(message)); },
  writeErr: (message) => { process.stderr.write(chalkStderr.red(message)); },
});

program.command("init")
  .description("Analyze a project and create .dockpack.yaml")
  .argument("[project-directory]", "project root", ".")
  .action(async (projectDirectory: string) => {
    const result = await initializeProject(projectDirectory);
    logger.success(`${result.created ? "Created" : "Found existing configuration; preserved it"}: ${chalk.bold(result.configPath)}`);
    logger.info(`Project: ${result.config.project.name} (${result.config.project.ecosystems.join(", ") || "not detected"})`);
    logger.info(`Compose services: ${result.services.join(", ") || "none detected"}`);
    logger.info(`开发目标平台：${result.config.target.dev_platform}${result.config.target.dev_platform === "auto" ? "（打包时跟随 Docker daemon；交付其他架构时请先修改）" : ""}`);
    logger.info(`开发启动命令：${result.config.application.dev_command.length ? JSON.stringify(result.config.application.dev_command) : "未设置，dev start 将尝试推断"}`);
    logger.info(`开发映射端口：${result.config.application.dev_port ?? "未显式设置"}（须与程序实际监听端口一致）`);
    logger.info(`开发容器网络：${result.config.compose.dev_networks.join(", ") || "Compose 默认网络"}`);
    logger.info("请检查 .dockpack.yaml 中的中文注释；完整配置说明：https://github.com/phobal/dockpack/blob/main/docs/configuration.md");
    if (result.findings.length) {
      logger.warn("Review findings:");
      for (const finding of result.findings) logger.warn(`  - ${finding}`);
    }
  });

const pack = program.command("pack").description("Create and inspect offline bundles");
pack.command("dev")
  .description("Create an offline development bundle on a connected machine")
  .argument("[project-directory]", "project root (defaults to the current working directory)", ".")
  .option("-o, --output <path>", "output archive path (default: <project>/.dockpack/offline-dev-<platform>.tar.gz)")
  .action(async (projectDirectory: string, options: { output?: string }) => {
    const output = await createDevelopmentBundle(projectDirectory, options.output);
    logger.success(`Created development bundle: ${output}`);
    logger.info(offlineRuntimeHint());
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
    const root = bundleCachePath(await bundleFingerprint(bundle));
    await mkdir(path.dirname(root), { recursive: true });
    await rm(root, { recursive: true, force: true });
    const extracted = await extractArchive(bundle, root);
    const manifest = await inspectArchive(bundle);
    if (manifest.target_platform !== docker.platform().id) throw new DockpackError(`Bundle targets ${manifest.target_platform}; Docker daemon uses ${docker.platform().id}.`);
    for (const file of await readdir(path.join(extracted, "images"))) if (file.endsWith(".tar")) docker.load(path.join(extracted, "images", file));
    logger.success(`Imported ${manifest.bundle_kind} bundle ${manifest.project_name} to ${extracted}`);
  });

const dev = program.command("dev").description("Manage an offline development environment");
dev.command("init")
  .description("Attach an offline bundle to the original project directory")
  .argument("[project-directory]", "project root (defaults to the current working directory)", ".")
  .option("--bundle <path>", "development bundle (default: <project>/.dockpack/offline-dev-<platform>.tar.gz)")
  .action(async (projectDirectory: string, options: { bundle?: string }) => {
    await initializeDevProject(projectDirectory, options.bundle);
    logger.success(`Initialized development environment in ${projectDirectory}`);
  });
dev.command("start").argument("[project-directory]", "project root (defaults to the current working directory)", ".").action(startDev);
dev.command("stop").argument("[project-directory]", "project root", ".").action(stopDev);
dev.command("rebuild").argument("[project-directory]", "project root", ".").action(rebuildDev);
dev.command("exec")
  .description("Run a command inside the development container")
  .argument("[project-directory]", "project root", ".")
  .argument("<command...>", "command after --")
  .allowUnknownOption(true)
  .action(execDev);

const build = program.command("build").description("Build offline deployment bundles");
build.command("prod")
  .argument("[project-directory]", "project root (defaults to the current working directory)", ".")
  .option("-o, --output <path>", "output archive path (default: <project>/.dockpack/offline-prod-<platform>.tar.gz)")
  .option("--bundle <path>", "development resource bundle (default: <project>/.dockpack/offline-dev-<platform>.tar.gz)")
  .action(async (projectDirectory: string, options: { output?: string; bundle?: string }) => {
    const output = await buildProductionBundle(projectDirectory, options.output, options.bundle);
    logger.success(`Created production bundle: ${output}`);
    logger.info(offlineRuntimeHint());
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
      logger.success(`Created backup: ${await backupProduction(bundle, options.output)}`);
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
  logger.field("Bundle kind:", manifest.bundle_kind);
  logger.field("Bundle schema:", manifest.schema_version);
  logger.field("Created with dockpack:", manifest.dockpack_version);
  logger.field("Project:", manifest.project_name);
  logger.field("Target:", manifest.target_platform);
  logger.field("Images:", manifest.images.join(", ") || "none");
  logger.field("Services:", manifest.services.join(", ") || "none");
  logger.field("Dependencies:", JSON.stringify(manifest.dependencies));
  logger.field("Payload members:", manifest.members.length);
}

program.showHelpAfterError();
program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error(`dockpack: error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});

function offlineRuntimeHint(): string {
  return `Offline host without Node.js: also transfer dockpack-cli-${VERSION}-<host-platform> (linux-x64, linux-arm64, win32-x64, darwin-x64 or darwin-arm64). Select the host OS, not the Docker image platform.`;
}
