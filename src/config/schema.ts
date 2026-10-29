import { z } from "zod";

export const composeConfigSchema = z.object({
  files: z.array(z.string()).default([]),
  profiles: z.array(z.string()).default([]),
  dev_networks: z.array(z.string().min(1)).default([]),
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
  runtime: z.object({
    python_version: z.string({ invalid_type_error: 'Python versions must be quoted strings, e.g. "3.12".' })
      .regex(/^(?:auto|[1-9]\d*\.\d+(?:\.\d+)?)$/, 'Use "auto" or a Python version such as "3.12" or "3.12.7".')
      .default("auto"),
    node_version: z.union([z.string(), z.number().int().positive()])
      .transform(String)
      .pipe(z.string().regex(/^(?:auto|v?[1-9]\d*(?:\.\d+){0,2})$/, 'Use "auto" or a Node.js version such as "22" or "22.14.0".'))
      .default("auto"),
  }).strict().default({}),
  application: z.object({
    service: z.string().default("app"),
    command: z.array(z.string()).default([]),
    build_command: z.array(z.string()).default([]),
    port: z.number().int().min(1).max(65535).nullable().default(null),
    dev_command: z.array(z.string()).default([]),
    dev_port: z.number().int().min(1).max(65535).nullable().default(null),
  }).strict().default({}),
  frontend: z.object({
    nginx_config: z.string().min(1).optional(),
    nginx_config_type: z.enum(["auto", "server", "main"]).default("auto"),
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
    required_env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  }).strict().default({}),
  target: z.object({
    dev_platform: z.enum(["auto", "linux/amd64", "linux/arm64"]).default("auto"),
    production_platform: z.enum(["linux/amd64", "linux/arm64"]).default("linux/amd64"),
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
