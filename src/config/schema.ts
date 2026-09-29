import { z } from "zod";

export const composeConfigSchema = z.object({
  files: z.array(z.string()).default([]),
  profiles: z.array(z.string()).default([]),
  include_services: z.array(z.string()).default([]),
  exclude_services: z.array(z.string()).default([]),
}).strict().superRefine((value, context) => {
  const excluded = new Set(value.exclude_services);
  const overlap = value.include_services.filter((name) => excluded.has(name));
  if (overlap.length > 0) {
    context.addIssue({
      code: "custom",
      message: `Services cannot be both included and excluded: ${overlap.join(", ")}`,
      path: ["include_services"],
    });
  }
});

export const dockpackConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  project: z.object({
    name: z.string().min(1),
    ecosystems: z.array(z.enum(["python", "node"])).default([]),
  }).strict(),
  application: z.object({
    service: z.string().default("app"),
    command: z.array(z.string()).default([]),
    port: z.number().int().min(1).max(65535).nullable().default(null),
  }).strict().default({}),
  target: z.object({
    production_platform: z.string().default("linux/amd64"),
  }).strict().default({}),
  compose: composeConfigSchema.default({}),
  dependencies: z.object({
    policy: z.literal("locked").default("locked"),
    python_files: z.array(z.string()).default([]),
    node_files: z.array(z.string()).default([]),
  }).strict().default({}),
}).strict();

export type DockpackConfig = z.infer<typeof dockpackConfigSchema>;

export function validateConfig(value: unknown): DockpackConfig {
  const parsed = dockpackConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("\n"));
  }
  return parsed.data;
}
