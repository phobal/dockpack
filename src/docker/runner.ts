import { spawnSync } from "node:child_process";
import { DockpackError } from "../errors.js";

export interface DockerPlatform {
  os: string;
  architecture: string;
  id: string;
}

export class DockerRunner {
  run(args: string[], options: { timeout?: number; cwd?: string; streamOutput?: boolean } = {}): string {
    const common = {
      timeout: options.timeout,
      cwd: options.cwd,
      maxBuffer: 64 * 1024 * 1024,
    };
    const result = options.streamOutput
      ? spawnSync("docker", args, { ...common, stdio: "inherit" })
      : spawnSync("docker", args, { ...common, encoding: "utf8" });
    if (result.error) throw new DockpackError(`Cannot run Docker CLI: ${result.error.message}`, { cause: result.error });
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? "";
      const stdout = result.stdout?.toString() ?? "";
      throw new DockpackError(`docker ${args.join(" ")} failed: ${(stderr || stdout || "unknown Docker error").trim()}`);
    }
    return result.stdout?.toString().trim() ?? "";
  }

  available(): boolean {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 8000 });
    return result.status === 0;
  }

  buildEnvironment(): NodeJS.ProcessEnv {
    const result = spawnSync("docker", ["buildx", "inspect"], { encoding: "utf8", timeout: 10000 });
    if (result.status === 0 && /\bStatus:\s*inactive\b/i.test(result.stdout)) {
      const context = spawnSync("docker", ["context", "show"], { encoding: "utf8", timeout: 10000 });
      const contextName = context.status === 0 ? context.stdout.trim() : "";
      if (contextName) {
        const candidate = spawnSync("docker", ["buildx", "inspect", contextName], { encoding: "utf8", timeout: 10000 });
        if (candidate.status === 0 && /\bStatus:\s*running\b/i.test(candidate.stdout)) {
          return { ...process.env, BUILDX_BUILDER: contextName };
        }
      }
    }
    return process.env;
  }

  platform(): DockerPlatform {
    const output = this.run(["info", "--format", "{{.OSType}}/{{.Architecture}}"], { timeout: 15000 });
    const [os, rawArchitecture] = output.split("/");
    const architecture = ({ x86_64: "amd64", aarch64: "arm64" } as Record<string, string>)[rawArchitecture ?? ""] ?? rawArchitecture;
    if (!os || !architecture) throw new DockpackError(`Docker daemon returned an invalid platform: ${output}`);
    return { os, architecture, id: `${os}/${architecture}` };
  }

  pull(image: string, platform: string, streamOutput = false): void {
    this.run(["pull", "--platform", platform, image], { streamOutput });
  }

  save(images: string[], outputFile: string, streamOutput = false): void {
    if (images.length === 0) throw new DockpackError("No images were selected for export.");
    this.run(["image", "save", "--output", outputFile, ...images], { streamOutput });
  }

  load(inputFile: string): void {
    this.run(["image", "load", "--input", inputFile]);
  }

  imagePlatform(image: string): string {
    return this.run(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image]);
  }

  hasImage(image: string): boolean {
    const result = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", timeout: 10000 });
    return result.status === 0;
  }
}
