import { spawnSync } from "node:child_process";
import { DockpackError } from "../errors.js";

export interface ComposeCommand {
  prefix: string[];
  version: string;
}

export function getComposeCommand(): ComposeCommand | undefined {
  const options = [["docker", "compose"], ["docker-compose"]];
  for (const prefix of options) {
    const result = spawnSync(prefix[0]!, [...prefix.slice(1), "version"], { encoding: "utf8", timeout: 8000 });
    if (result.status === 0) return { prefix, version: (result.stdout || result.stderr).trim() };
  }
  return undefined;
}

export function runCompose(prefix: string[], args: string[], cwd: string): string {
  const command = getComposeCommand();
  if (!command) throw new DockpackError("Neither 'docker compose' nor 'docker-compose' is available.");
  const result = spawnSync(command.prefix[0]!, [...command.prefix.slice(1), ...prefix, ...args], {
    cwd,
    encoding: "utf8",
    timeout: undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new DockpackError(`Cannot run Compose: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new DockpackError((result.stderr || result.stdout || "Compose command failed").trim());
  return result.stdout.trim();
}
