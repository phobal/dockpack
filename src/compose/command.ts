import { spawn, spawnSync } from "node:child_process";
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

export function runCompose(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const command = getComposeCommand();
  if (!command) throw new DockpackError("Neither 'docker compose' nor 'docker-compose' is available.");
  const result = spawnSync(command.prefix[0]!, [...command.prefix.slice(1), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new DockpackError(`Cannot run Compose: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new DockpackError((result.stderr || result.stdout || "Compose command failed").trim());
  return result.stdout.trim();
}

export interface ComposeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function runComposeAttached(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<ComposeExit> {
  const command = getComposeCommand();
  if (!command) throw new DockpackError("Neither 'docker compose' nor 'docker-compose' is available.");
  return new Promise((resolve, reject) => {
    const child = spawn(command.prefix[0]!, [...command.prefix.slice(1), ...args], { cwd, env, stdio: "inherit" });
    let requestedSignal: NodeJS.Signals | null = null;
    const forwardSignal = (signal: NodeJS.Signals) => {
      requestedSignal = signal;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    child.once("error", (error) => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      reject(new DockpackError(`Cannot run Compose: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      resolve({ code, signal: signal ?? requestedSignal });
    });
  });
}
