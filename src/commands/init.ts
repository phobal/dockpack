import path from "node:path";
import { createConfigOnce, readConfig } from "../config/io.js";
import type { DockpackConfig } from "../config/schema.js";
import { analyzeCompose } from "../compose/inspect.js";
import { detectProject, inferStartCommand } from "../project/detect.js";
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
  const composeApplication = compose.services.find((service) => {
    const build = service.build;
    const context = typeof build === "string" ? build : build && typeof build === "object" ? (build as { context?: string }).context : undefined;
    if (context && path.resolve(root, context) === root) return true;
    return ["app", "api", "web", "backend", "server"].includes(service.name.toLowerCase());
  });
  const applicationService = composeApplication?.name ?? "app";
  const command = await inferStartCommand(root, detections);
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
    application: { service: applicationService, command, port },
    target: { production_platform: "linux/amd64" },
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
  try {
    created = await createConfigOnce(root, rawConfig as DockpackConfig);
    if (!created) await readConfig(configPath);
  } catch (error) {
    if (error instanceof DockpackError) throw error;
    throw new DockpackError(`Project initialization failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return {
    configPath,
    created,
    config: rawConfig as DockpackConfig,
    findings: [...detections.flatMap((item) => item.findings), ...compose.findings],
    services: compose.services.map((service) => service.name),
  };
}
