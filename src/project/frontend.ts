import { readFile } from "node:fs/promises";
import path from "node:path";

export const STATIC_FRONTEND_IMAGE = "nginx:stable-alpine";

export interface StaticFrontend {
  command: string[];
  mode: string;
  vite: Record<string, unknown>;
}

function option(source: string, name: string): string | undefined {
  const matches = [...source.matchAll(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s;&|]+))`, "g"))];
  const match = matches.at(-1);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export async function detectStaticFrontend(root: string, startCommand: string[], buildCommand: string[]): Promise<StaticFrontend | undefined> {
  // An explicit start command retains the existing application-server workflow.
  if (startCommand.length) return undefined;
  let text: string;
  try {
    text = await readFile(path.join(root, "package.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const pkg = JSON.parse(text) as {
    scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  };
  if (!pkg.dependencies?.vite && !pkg.devDependencies?.vite) return undefined;
  const command = buildCommand.length ? buildCommand : ["npm", "run", "build"];
  if (command[0] !== "npm" || command[1] !== "run" || !command[2]) return undefined;
  const script = pkg.scripts?.[command[2]];
  if (!script || !/\bvite\s+build(?:\s|$)/.test(script)) return undefined;
  const source = `${script} ${command.slice(3).join(" ")}`;
  if (/--(?:ssr|watch)(?:\s|=|$)/.test(source)) return undefined;
  const mode = option(source, "mode") ?? "production";
  const vite: Record<string, unknown> = { mode };
  const configFile = option(source, "config");
  const outDir = option(source, "outDir");
  const base = option(source, "base");
  if (configFile !== undefined) vite.configFile = configFile;
  if (outDir !== undefined) vite.build = { outDir };
  if (base !== undefined) vite.base = base;
  return { command, mode, vite };
}
