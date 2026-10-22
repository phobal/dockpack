import path from "node:path";
import { createConfigOnce, readConfig } from "../config/io.js";
import type { DockpackConfig } from "../config/schema.js";
import { analyzeCompose } from "../compose/inspect.js";
import { detectProject, inferBuildCommand, inferDevelopmentServer, inferStartCommand } from "../project/detect.js";
import { DockpackError } from "../errors.js";

export interface InitSummary {
  configPath: string;
  created: boolean;
  config: DockpackConfig;
  findings: string[];
  services: string[];
}

export async function initializeProject(projectDir: string): Promise<InitSummary> {
  const root = path.resolve(projectDir);
  const detections = await detectProject(root);
  const compose = await analyzeCompose(root);
  let packageName = "";
  try {
    packageName = (JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "package.json"), "utf8")) as { name?: string }).name ?? "";
  } catch { /* Non-Node projects use the directory name. */ }
  const identities = [path.basename(root), packageName].filter(Boolean).map((item) => item.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  const composeApplication = compose.services.find((service) => {
    const build = service.build;
    const context = typeof build === "string" ? build : build && typeof build === "object" ? (build as { context?: string }).context : undefined;
    if (context && path.resolve(root, context) === root) return true;
    if (["app", "api", "web", "backend", "server"].includes(service.name.toLowerCase())) return true;
    const serviceName = service.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const imageName = typeof service.image === "string" ? service.image.split("/").at(-1)?.split(":")[0]?.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
    return identities.some((identity) => identity === serviceName || identity === imageName);
  });
  const applicationService = composeApplication?.name ?? "app";
  const command = await inferStartCommand(root, detections);
  const developmentServer = await inferDevelopmentServer(root, detections);
  const buildCommand = await inferBuildCommand(root, detections);
  let port: number | null = null;
  const ports = composeApplication?.ports;
  if (Array.isArray(ports) && ports.length > 0) {
    const first = ports[0];
    const target = first && typeof first === "object" ? (first as { target?: number }).target : undefined;
    const portText = typeof first === "string" ? first.split(":").at(-1)?.split("/")[0] : undefined;
    const value = target ?? Number(portText);
    if (Number.isInteger(value) && value > 0 && value <= 65535) port = value;
  }
  const filesByEcosystem = new Map(detections.map((item) => [item.ecosystem, [...item.dependencyFiles, ...item.lockFiles]]));
  const rawConfig = {
    schema_version: 1,
    project: { name: path.basename(root), ecosystems: detections.map((item) => item.ecosystem) },
    application: {
      service: applicationService,
      command,
      build_command: buildCommand,
      port,
      dev_command: developmentServer.command,
      dev_port: developmentServer.port,
    },
    target: { dev_platform: "auto", production_platform: "linux/amd64" },
    compose: {
      files: compose.files.map((file) => path.relative(root, file)),
      profiles: [],
      include_services: compose.services.filter((service) => service.name !== applicationService).map((service) => service.name),
      exclude_services: [],
    },
    dependencies: {
      policy: "locked",
      python_files: filesByEcosystem.get("python") ?? [],
      node_files: filesByEcosystem.get("node") ?? [],
    },
  };
  const configPath = path.join(root, ".dockpack.yaml");
  let created: boolean;
  let config = rawConfig as DockpackConfig;
  try {
    created = await createConfigOnce(root, rawConfig as DockpackConfig);
    if (!created) config = await readConfig(configPath);
  } catch (error) {
    if (error instanceof DockpackError) throw error;
    throw new DockpackError(`Project initialization failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return {
    configPath,
    created,
    config,
    findings: [...detections.flatMap((item) => item.findings), ...compose.findings],
    services: compose.services.map((service) => service.name),
  };
}
