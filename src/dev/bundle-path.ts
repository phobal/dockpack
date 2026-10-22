import path from "node:path";

export function defaultDevelopmentBundlePath(projectDir: string, platform: string): string {
  return path.resolve(projectDir, ".dockpack", `offline-dev-${platform.replaceAll("/", "-")}.tar.gz`);
}
