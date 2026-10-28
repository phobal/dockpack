import { DockpackError } from "../errors.js";
import { logger } from "../logger.js";
import type { DockerRunner } from "./runner.js";

export type PullPolicy = "missing" | "always" | "never";

/** One collector per bundle; always recheck architecture because tags can be replaced. */
export function createImageCollector(
  docker: Pick<DockerRunner, "hasImage" | "imagePlatform" | "pull">,
  policy: PullPolicy = "missing",
): (image: string, platform: string) => void {
  if (!["missing", "always", "never"].includes(policy)) {
    throw new DockpackError(`Invalid image pull policy '${policy}'; expected missing, always or never.`);
  }
  const collected = new Set<string>();
  return (image, platform) => {
    const actual = docker.hasImage(image) ? docker.imagePlatform(image) : undefined;
    const key = `${image}\n${platform}`;
    if (actual === platform && (policy !== "always" || collected.has(key))) {
      logger.info(`[dockpack] Using cached image ${image} (${platform}).`);
      collected.add(key);
      return;
    }
    if (policy === "never") {
      throw new DockpackError(`Image '${image}' is ${actual ?? "missing locally"}; required ${platform}, but --pull never forbids pulling. Load a matching image or retry with --pull missing.`);
    }
    docker.pull(image, platform, true);
    collected.add(key);
  };
}
