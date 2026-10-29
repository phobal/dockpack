import { existsSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DockpackConfig } from "../config/schema.js";
import { DockpackError } from "../errors.js";
import { nginxTemplate } from "./frontend-nginx.js";

export interface FrontendRuntime {
  content: string;
  main: boolean;
  environment: Record<string, string>;
  required: string[];
  variables: string[];
}

export async function frontendRuntime(root: string, config: DockpackConfig, base: string): Promise<FrontendRuntime> {
  const settings = config.frontend;
  const filename = settings.nginx_config ?? (existsSync(path.join(root, "nginx.conf")) ? "nginx.conf" : undefined);
  let content = nginxTemplate(base, false);
  if (filename) {
    const absolute = await realpath(path.resolve(root, filename));
    const relative = path.relative(await realpath(root), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new DockpackError("frontend.nginx_config must be a file inside the project.");
    content = await readFile(absolute, "utf8");
  }
  const main = settings.nginx_config_type === "main" || (settings.nginx_config_type === "auto" && /^\s*(?:events\s*\{|http\s*\{|worker_processes\s)/m.test(content));
  const variables = new Set([...Object.keys(settings.environment), ...settings.required_env]);
  // Only uppercase braced placeholders are environment variables. Nginx's
  // own $uri, $host and $request_uri must survive template substitution.
  for (const match of content.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) variables.add(match[1]!);
  const required = [...new Set(settings.required_env)];
  const environment: Record<string, string> = {};
  for (const name of variables) environment[name] = settings.environment[name] ?? `\${${name}:-}`;
  for (const name of required) environment[name] = `\${${name}:?Set ${name} in the deployment env file}`;
  return { content, main, environment, required, variables: [...variables] };
}

/** Keep one project-owned example at the bundle root; never copy real .env secrets. */
export async function writeEnvironmentExample(root: string, stage: string, names: Iterable<string>): Promise<void> {
  const source = path.join(root, ".env.example");
  let content = existsSync(source) ? await readFile(source, "utf8") : "";
  const existing = new Set([...content.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]));
  for (const name of new Set(names)) {
    if (existing.has(name)) continue;
    if (content && !content.endsWith("\n")) content += "\n";
    content += `${name}=\n`;
  }
  await writeFile(path.join(stage, ".env.example"), content, "utf8");
}
