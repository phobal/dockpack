import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { DockpackError } from "../errors.js";

export const UV_REQUIREMENTS = "python-requirements.txt";
export const UV_VERSION = "0.13.6";
export const UV_EXPORT_ARGS = [
  "export", "--locked", "--no-emit-project", "--format", "requirements.txt",
  "--no-header", "--no-annotate", "--emit-index-url", "--no-python-downloads",
  "--output-file", `/cache/${UV_REQUIREMENTS}`,
];
export const UV_EXPORT_SCRIPT = [
  "import subprocess, sys",
  `subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', 'uv==${UV_VERSION}'], check=True)`,
  `subprocess.run(['uv', *${JSON.stringify(UV_EXPORT_ARGS)}, '--python', sys.executable], check=True)`,
].join("\n");

export const PYTHON_OFFLINE_CHECK = [
  "import subprocess, venv",
  "venv.create('/tmp/dockpack-python-check', with_pip=True)",
  `subprocess.run(['/tmp/dockpack-python-check/bin/python', '-m', 'pip', 'install', '--no-index', '--only-binary=:all:', '--find-links=/cache/python', '-r', '/cache/${UV_REQUIREMENTS}'], check=True)`,
  "subprocess.run(['/tmp/dockpack-python-check/bin/python', '-m', 'pip', 'check'], check=True)",
].join("\n");

export function pythonDependencyFiles(root: string): string[] {
  if (existsSync(path.join(root, "uv.lock"))) {
    if (!existsSync(path.join(root, "pyproject.toml"))) throw new DockpackError("uv.lock requires pyproject.toml in the project root.");
    return ["pyproject.toml", "uv.lock", ...(existsSync(path.join(root, "uv.toml")) ? ["uv.toml"] : [])];
  }
  const requirements = ["requirements.txt", "requirements-dev.txt"].find(name => existsSync(path.join(root, name)));
  if (!requirements) throw new DockpackError("Python dependencies require pyproject.toml with uv.lock, or requirements.txt / requirements-dev.txt.");
  return [requirements];
}

export function pythonRequirementsPath(root: string, cache: string): string {
  const files = pythonDependencyFiles(root);
  if (!files.includes("uv.lock")) return path.join(root, files[0]!);
  const requirements = path.join(cache, UV_REQUIREMENTS);
  if (!existsSync(requirements)) throw new DockpackError("The uv requirements export is missing from the bundle. Recreate it with 'dockpack pack dev' on a connected machine.");
  return requirements;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function validateUvProject(root: string): void {
  const project = parse(readFileSync(path.join(root, "pyproject.toml"), "utf8"));
  if (object(object(project.tool).uv).workspace !== undefined) {
    throw new DockpackError("uv workspace projects are not yet supported for offline packaging. Package a standalone project with registry dependencies.");
  }
  const lock = parse(readFileSync(path.join(root, "uv.lock"), "utf8"));
  for (const value of Array.isArray(lock.package) ? lock.package : []) {
    const pkg = object(value);
    const source = object(pkg.source);
    if (typeof source.registry === "string" || source.virtual === "." || source.editable === ".") continue;
    throw new DockpackError(`uv dependency '${pkg.name}' uses a Git, URL or local path source. Offline uv packaging currently supports registry dependencies only.`);
  }
}

/** Keep pinned requirements and hashes; remove index URLs from the offline copy. */
export function portableUvRequirements(text: string): string {
  const lines = text.split(/\r?\n/).filter(line => !/^\s*--(?:extra-)?index-url\b/.test(line));
  for (const line of lines) {
    const entry = line.trim().replace(/\s*\\$/, "");
    if (!entry || entry.startsWith("#") || /^--hash=sha256:[a-f\d]{64}$/i.test(entry)) continue;
    if (!/^[a-z\d][a-z\d._-]*(?:\[[a-z\d_,.-]+\])?==[^\s;@]+(?:\s*;.*)?$/i.test(entry)) {
      throw new DockpackError("uv export contains a local, direct URL or unpinned dependency that cannot be installed offline. Use registry dependencies in uv.lock.");
    }
  }
  return lines.join("\n");
}
