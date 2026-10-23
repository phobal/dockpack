import { logger } from "../logger.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkedNpmInstall } from "../dev/dependencies.js";
import { readNativeBuildResource } from "../dev/build-resources.js";
import { DockerRunner } from "../docker/runner.js";
import { DockpackError } from "../errors.js";
import { productionStep } from "./progress.js";

const prepareWorkspace = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const options = { recursive: true, verbatimSymlinks: true };
fs.cpSync("/dockpack-source", "/workspace", options);
const pkg = JSON.parse(fs.readFileSync("/workspace/package.json", "utf8"));
const lifecycle = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"].some(name => pkg.scripts?.[name]);
const ready = "/dockpack-dependencies/ready";
if (!lifecycle && fs.existsSync(ready)) {
  console.log("[dockpack] Reusing installed frontend dependencies from Docker volume.");
  fs.cpSync(ready, "/workspace/node_modules", options);
} else {
  console.log(lifecycle ? "[dockpack] Installing dependencies; project lifecycle scripts require a fresh install." : "[dockpack] Frontend dependency cache miss; installing offline.");
  const result = spawnSync(process.execPath, ["-e", process.argv[1], "--", "--offline", "--cache", "/dockpack-cache/npm", "--include=dev", "--include=optional"], { stdio: "inherit", cwd: "/workspace" });
  if (result.error || result.status !== 0) process.exit(1);
  if (!lifecycle) {
    const pending = "/dockpack-dependencies/pending-" + require("node:crypto").randomUUID();
    try {
      fs.cpSync("/workspace/node_modules", pending, options);
      try { fs.renameSync(pending, ready); }
      catch (error) { if (!fs.existsSync(ready) || !["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    } finally { fs.rmSync(pending, { recursive: true, force: true }); }
  }
}
`;

export async function createFrontendWorkspace(project: string, source: string, cacheDir: string, fallbackImage: string, docker: DockerRunner) {
  const root = path.dirname(cacheDir);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { target_platform: string };
  const daemonPlatform = docker.platform().id;
  const native = await readNativeBuildResource(root, daemonPlatform);
  const image = native?.image ?? fallbackImage;
  const platform = native?.platform ?? manifest.target_platform;
  const npmCache = path.resolve(native ? path.join(native.directory, "cache", "npm") : path.join(cacheDir, "npm"));
  if (docker.imagePlatform(image) !== platform) throw new DockpackError(`Frontend build image ${image} must target ${platform}.`);
  logger.info(`[dockpack] Frontend build platform: ${platform}; production image platform is unchanged.`);
  if (platform !== daemonPlatform) logger.warn("[dockpack] Native frontend resources are absent; using architecture emulation. Recreate the development bundle on this build machine to include native resources.");
  if ([source, npmCache].some(value => value.includes(","))) throw new DockpackError("Docker bind mount paths containing commas are not supported.");
  const fingerprint = createHash("sha256")
    .update("dockpack-frontend-dependencies-v1\0").update(path.resolve(project)).update("\0")
    .update(await readFile(path.join(source, "package.json"))).update("\0")
    .update(await readFile(path.join(source, "package-lock.json"))).update("\0")
    .update(docker.imageId(image)).update("\0").update(platform).digest("hex");
  const workspace = `dockpack-build-${randomUUID()}`;
  const dependencies = `dockpack-frontend-deps-${fingerprint}`;
  docker.run(["volume", "create", "--label", "dockpack.kind=frontend-dependencies", dependencies]);
  docker.run(["volume", "create", "--label", "dockpack.kind=build-workspace", workspace]);
  const args = ["run", "--rm", "--pull", "never", "--network", "none", "--platform", platform,
    "--mount", `type=volume,source=${workspace},target=/workspace`, "--workdir", "/workspace"];
  const cleanup = () => {
    try { docker.run(["volume", "rm", workspace]); }
    catch (error) { logger.warn(`[dockpack] Could not remove temporary workspace volume '${workspace}': ${error instanceof Error ? error.message : String(error)}`); }
  };
  try {
    await productionStep("Preparing Docker workspace and offline frontend dependencies", () => docker.run([
      ...args,
      "--mount", `type=bind,source=${source},target=/dockpack-source,readonly`,
      "--mount", `type=bind,source=${npmCache},target=/dockpack-cache/npm,readonly`,
      "--mount", `type=volume,source=${dependencies},target=/dockpack-dependencies`,
      image, "node", "-e", prepareWorkspace, "--", checkedNpmInstall,
    ], { streamOutput: true }));
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    run: (command: string[]) => docker.run([...args, image, ...command], { streamOutput: true }),
    metadata: () => JSON.parse(docker.run([...args, image, "node", "-e",
      'process.stdout.write(require("fs").readFileSync("/workspace/.dockpack-static-build.json", "utf8"))'])) as { output: string; base: string },
    copyOutput: (output: string, destination: string) => {
      docker.run([...args, image, "node", "-e", 'if (!require("fs").statSync(process.argv[1] + "/index.html").isFile()) process.exit(1)', "--", `/workspace/${output}`]);
      const container = docker.run(["create", "--pull", "never", "--platform", platform, "--mount", `type=volume,source=${workspace},target=/workspace`, image, "node"]);
      try { docker.run(["cp", `${container}:/workspace/${output}/.`, destination]); }
      finally { docker.run(["rm", container]); }
    },
    cleanup,
  };
}
