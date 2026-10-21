import { z } from "zod";
import { DockpackError } from "../errors.js";
import { VERSION } from "../version.js";

export const bundleManifestSchema = z.object({
  schema_version: z.literal(1),
  bundle_kind: z.enum(["dev", "prod"]),
  dockpack_version: z.string(),
  project_name: z.string(),
  target_platform: z.string(),
  created_at: z.string(),
  images: z.array(z.string()),
  dependencies: z.record(z.string(), z.string()),
  services: z.array(z.string()),
  findings: z.array(z.string()).default([]),
  required_config: z.array(z.string()).default([]),
  persistent_volumes: z.array(z.string()).default([]),
  members: z.array(z.object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
}).strict();

export type BundleManifest = z.infer<typeof bundleManifestSchema>;

export function parseBundleManifest(value: unknown): BundleManifest {
  const schemaVersion = value && typeof value === "object" && "schema_version" in value
    ? value.schema_version : undefined;
  if (typeof schemaVersion === "number" && schemaVersion !== 1) {
    throw new DockpackError(
      `Bundle schema version ${schemaVersion} is not supported by dockpack ${VERSION} (supported: 1). ` +
      "Transfer a compatible dockpack offline runtime package from a connected machine.",
    );
  }
  return bundleManifestSchema.parse(value);
}

type NewManifest = Omit<BundleManifest, "schema_version" | "created_at" | "members" | "findings" | "required_config" | "persistent_volumes">
  & Partial<Pick<BundleManifest, "findings" | "required_config" | "persistent_volumes">>;

export function makeManifest(value: NewManifest): BundleManifest {
  return bundleManifestSchema.parse({
    schema_version: 1,
    created_at: new Date().toISOString(),
    members: [],
    findings: [],
    required_config: [],
    persistent_volumes: [],
    ...value,
  });
}
