import checkbox from "@inquirer/checkbox";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DockpackError } from "../errors.js";
import { logger } from "../logger.js";
import { VERSION } from "../version.js";

const platforms = [
  { name: "Linux x64 (linux/amd64)", value: "linux/amd64", target: "linux-x64" },
  { name: "Linux ARM64 (linux/arm64)", value: "linux/arm64", target: "linux-arm64" },
  { name: "Windows x64 (windows/amd64)", value: "windows/amd64", target: "win32-x64" },
  { name: "macOS Intel (darwin/amd64)", value: "darwin/amd64", target: "darwin-x64" },
  { name: "macOS Apple Silicon (darwin/arm64)", value: "darwin/arm64", target: "darwin-arm64" },
] as const;

function resolvePlatforms(values: string[]) {
  return [...new Set(values.flatMap(value => value.split(",")).map(value => {
    const input = value.trim();
    const platform = platforms.find(item => item.value === input || item.target === input);
    if (!platform) {
      throw new DockpackError(`Unsupported platform '${input}'. Supported platforms: ${platforms.map(item => item.value).join(", ")}.`);
    }
    return platform;
  }))];
}

async function request(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DockpackError(`HTTP ${response.status}: ${url}${response.status === 404 ? `. Check that release v${VERSION} includes offline runtime assets.` : ""}`);
  }
  return response;
}

async function downloadPlatform(platform: typeof platforms[number], directory: string): Promise<void> {
  const filename = `dockpack-cli-${VERSION}-${platform.target}.${platform.target === "win32-x64" ? "zip" : "tar.gz"}`;
  const url = `https://github.com/phobal/dockpack/releases/download/v${VERSION}/${filename}`;
  const temporary = await mkdtemp(path.join(directory, ".download-"));
  logger.info(`Downloading dockpack ${VERSION} for ${platform.value}...`);
  try {
    const response = await request(url);
    if (!response.body) throw new DockpackError(`Empty download response for ${filename}.`);
    const reader = response.body.getReader();
    await pipeline(
      async function* () {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      createWriteStream(path.join(temporary, filename)),
    );
    await rename(path.join(temporary, filename), path.join(directory, filename));
    logger.success(`Downloaded: ${path.join(directory, filename)}`);
  } catch (error) {
    throw new DockpackError(`Download failed for ${platform.value}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function downloadOfflineCli(requestedPlatforms: string[] = []): Promise<void> {
  let selected = resolvePlatforms(requestedPlatforms);
  if (!selected.length) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new DockpackError("Platform selection requires an interactive terminal. Specify platforms with -p, for example: dockpack download -p linux/amd64 linux/arm64");
    }
    try {
      const values = await checkbox({
        message: "选择运行 dockpack 的主机平台（空格多选，回车下载）",
        choices: platforms.map(({ name, value }) => ({ name, value })),
        required: true,
        pageSize: platforms.length,
      });
      selected = resolvePlatforms(values);
    } catch (error) {
      if (error instanceof Error && error.name === "ExitPromptError") {
        logger.info("已取消下载。");
        process.exitCode = 130;
        return;
      }
      throw error;
    }
  }
  const directory = path.resolve(".dockpack");
  await mkdir(directory, { recursive: true });
  logger.field("下载目录：", directory);
  for (const platform of selected) await downloadPlatform(platform, directory);
  logger.success(`下载完成，文件保存在：${directory}`);
}
