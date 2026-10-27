import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DockerRunner } from "../docker/runner.js";
import type { EcosystemDetection } from "../project/detect.js";
import { collectNpm, runtimeImage, type RuntimeVersions } from "./dependencies.js";

const resourceSchema = z.object({
  platform: z.enum(["linux/amd64", "linux/arm64"]),
  image: z.string().regex(/^dockpack\/build-node:sha256-[a-f0-9]{64}$/),
  image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  lock_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function readNativeBuildResource(root: string, platform: string) {
  const directory = path.join(root, "build-resources", platform.replaceAll("/", "-"));
  try {
    const resource = resourceSchema.parse(JSON.parse(await readFile(path.join(directory, "resource.json"), "utf8")));
    if (resource.platform !== platform) throw new Error("Native build resource platform mismatch.");
    return { ...resource, directory };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function collectNativeBuildResource(project: string, stage: string, detection: EcosystemDetection, developmentPlatform: string, docker: DockerRunner, runtimeVersions: RuntimeVersions = {}): Promise<void> {
  const platform = docker.platform().id;
  if (platform === developmentPlatform || !["linux/amd64", "linux/arm64"].includes(platform)) return;
  const directory = path.join(stage, "build-resources", platform.replaceAll("/", "-"));
  await mkdir(directory, { recursive: true });
  const runtime = await runtimeImage(detection, project, runtimeVersions);
  const original = docker.hasImage(runtime) ? docker.imageId(runtime) : undefined;
  let image: string;
  let imageId: string;
  try {
    docker.pull(runtime, platform, true);
    if (docker.imagePlatform(runtime) !== platform) throw new Error(`Native build image must target ${platform}.`);
    imageId = docker.imageId(runtime);
    image = `dockpack/build-node:sha256-${imageId.slice("sha256:".length)}`;
    docker.run(["image", "tag", imageId, image]);
  } finally {
    // Keep the development image tag pointing at its original architecture.
    if (original) docker.run(["image", "tag", original, runtime]);
  }
  const dependency = await collectNpm(project, path.join(directory, "cache"), image, docker, platform);
  docker.save([image], path.join(directory, "images.tar"), true);
  const resource = resourceSchema.parse({ platform, image, image_id: imageId, lock_digest: dependency.lockDigest });
  await writeFile(path.join(directory, "resource.json"), JSON.stringify(resource, null, 2), "utf8");
}
