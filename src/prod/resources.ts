import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "../bundles/archive.js";
import { parseBundleManifest } from "../bundles/manifest.js";
import { sha256Files } from "../dev/dependencies.js";
import { DockerRunner } from "../docker/runner.js";
import { DockpackError } from "../errors.js";
import { detectProject } from "../project/detect.js";
import { detectStaticFrontend, STATIC_FRONTEND_IMAGE } from "../project/frontend.js";
import { readNativeBuildResource } from "../dev/build-resources.js";
import { readConfig } from "../config/io.js";
import { productionStep } from "./progress.js";

export async function prepareProductionResources(projectDir: string, bundlePath: string, destination: string, docker: DockerRunner, platform: string): Promise<string> {
  if (!existsSync(bundlePath)) {
    throw new DockpackError(`Development resource bundle not found: ${bundlePath}. Run 'dockpack pack dev' on a connected machine first, or specify build prod --bundle <path>. No dev init is required.`);
  }
  console.log(`[dockpack] Verifying production build resources: ${bundlePath}`);
  const root = await productionStep("Extracting and verifying build resource archive", () => extractArchive(bundlePath, destination));
  const manifest = parseBundleManifest(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
  if (manifest.bundle_kind !== "dev") throw new DockpackError("Production build resources must be a development bundle created with 'dockpack pack dev'.");
  const config = await readConfig(path.join(projectDir, ".dockpack.yaml"));
  const staticFrontend = await detectStaticFrontend(projectDir, config.application.command, config.application.build_command);
  if (manifest.target_platform !== platform && !staticFrontend) {
    throw new DockpackError(`Development resources target ${manifest.target_platform}; production build needs ${platform}. Set target.dev_platform to ${platform} and recreate the bundle on a connected machine. The Docker daemon architecture does not need to match if emulation is available.`);
  }
  const detections = await detectProject(projectDir);
  for (const detection of detections) {
    if (!manifest.dependencies[detection.ecosystem]) throw new DockpackError(`Development resources are missing ${detection.ecosystem} dependencies. Recreate the development bundle.`);
  }
  for (const [ecosystem, expected] of Object.entries(manifest.dependencies)) {
    let files: string[];
    if (ecosystem === "node") files = ["package-lock.json"];
    else if (ecosystem === "python") {
      const requirements = ["requirements.txt", "requirements-dev.txt"].find((name) => existsSync(path.join(projectDir, name)));
      if (!requirements) throw new DockpackError("Production resources require the Python requirements file used when creating the development bundle.");
      files = [requirements];
    } else throw new DockpackError(`Unsupported production dependency ecosystem: ${ecosystem}.`);
    let actual: string;
    try {
      actual = await sha256Files(projectDir, files);
    } catch (error) {
      throw new DockpackError(`Cannot read production dependency inputs for ${ecosystem}. Restore the original dependency files or recreate the development bundle.`, { cause: error });
    }
    if (actual !== expected) throw new DockpackError(`${ecosystem} dependency files differ from the development bundle. Recreate the bundle on a connected machine before building production images.`);
  }
  console.log("[dockpack] Importing bundled production build images...");
  for (const filename of await readdir(path.join(root, "images"))) {
    if (filename.endsWith(".tar")) await productionStep(`Importing build images: ${filename}`, () => docker.load(path.join(root, "images", filename)));
  }
  for (const image of manifest.images) {
    const expected = staticFrontend && image !== STATIC_FRONTEND_IMAGE ? manifest.target_platform : platform;
    if (!docker.hasImage(image) || docker.imagePlatform(image) !== expected) {
      throw new DockpackError(`Imported production build image ${image} is missing or does not target ${expected}. Recreate the development bundle with matching images.`);
    }
  }
  const native = staticFrontend ? await readNativeBuildResource(root, docker.platform().id) : undefined;
  if (native) {
    if (native.lock_digest !== manifest.dependencies.node) throw new DockpackError("Native frontend dependency cache does not match the development bundle lock file.");
    const cached = docker.hasImage(native.image) && docker.imageId(native.image) === native.image_id && docker.imagePlatform(native.image) === native.platform;
    if (!cached) await productionStep(`Importing native frontend build image (${native.platform})`, () => docker.load(path.join(native.directory, "images.tar")));
    else console.log(`[dockpack] Using cached native frontend build image (${native.platform}).`);
    if (docker.imageId(native.image) !== native.image_id || docker.imagePlatform(native.image) !== native.platform) {
      throw new DockpackError("Native frontend build image does not match its bundled identity and platform.");
    }
  }
  return root;
}

export function defaultProductionBundlePath(projectDir: string, platform: string): string {
  return path.resolve(projectDir, ".dockpack", `offline-prod-${platform.replaceAll("/", "-")}.tar.gz`);
}
