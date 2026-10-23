import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ComposeModel } from "../compose/inspect.js";
import type { BundleManifest } from "../bundles/manifest.js";
import { DockerRunner } from "../docker/runner.js";
import { DockpackError } from "../errors.js";

const IMAGE_IDS_PATH = "images/image-ids.json";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

export async function exportProductionImages(model: ComposeModel, docker: DockerRunner, stage: string, platform: string): Promise<string[]> {
  const identities: Record<string, string> = {};
  for (const [name, service] of Object.entries(model.services)) {
    const original = service.image;
    if (typeof original !== "string" || original.includes("$")) {
      throw new DockpackError(`Production service '${name}' needs a concrete local image reference.`);
    }
    if (!docker.hasImage(original)) throw new DockpackError(`Production image ${original} for '${name}' is missing locally.`);
    if (docker.imagePlatform(original) !== platform) throw new DockpackError(`Production image ${original} for '${name}' is not ${platform}.`);
    const id = docker.imageId(original);
    if (!IMAGE_ID.test(id)) throw new DockpackError(`Docker returned an invalid image ID for '${name}'.`);
    // The content-derived tag isolates bundles even when source tags are reused.
    const reference = `dockpack/bundle-image:sha256-${id.slice("sha256:".length)}`;
    docker.run(["image", "tag", id, reference]);
    service.image = reference;
    service.pull_policy = "never";
    identities[reference] = id;
  }
  const images = Object.keys(identities);
  await mkdir(path.join(stage, "images"), { recursive: true });
  docker.save(images, path.join(stage, "images", "images.tar"));
  await writeFile(path.join(stage, IMAGE_IDS_PATH), `${JSON.stringify(identities, null, 2)}\n`, "utf8");
  return images;
}

export async function readProductionImageIds(root: string, manifest: BundleManifest): Promise<Record<string, string> | undefined> {
  const member = manifest.members.find((entry) => entry.path === IMAGE_IDS_PATH);
  // Legacy bundles have no identity file; activation must reload their archives.
  if (!member) return undefined;
  const content = await readFile(path.join(root, IMAGE_IDS_PATH));
  if (createHash("sha256").update(content).digest("hex") !== member.sha256) {
    throw new DockpackError("Production image identity file checksum mismatch; import the bundle into a clean deployment directory.");
  }
  const identities: unknown = JSON.parse(content.toString("utf8"));
  if (!identities || typeof identities !== "object" || Array.isArray(identities)
    || Object.keys(identities).length !== manifest.images.length) {
    throw new DockpackError("Production image identities do not match the bundle manifest.");
  }
  const result = identities as Record<string, unknown>;
  for (const image of manifest.images) {
    if (!Object.hasOwn(result, image) || typeof result[image] !== "string" || !IMAGE_ID.test(result[image])) {
      throw new DockpackError(`Missing or invalid production image identity for ${image}.`);
    }
  }
  return result as Record<string, string>;
}
