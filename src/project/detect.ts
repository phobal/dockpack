import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface EcosystemDetection {
  ecosystem: "python" | "node";
  packageManager: string | null;
  runtimeConstraint: string | null;
  dependencyFiles: string[];
  lockFiles: string[];
  confidence: "high" | "medium";
  findings: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function detectPython(projectDir: string): Promise<EcosystemDetection | undefined> {
  const candidates = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "Pipfile"];
  const dependencyFiles: string[] = [];
  for (const filename of candidates) if (await exists(path.join(projectDir, filename))) dependencyFiles.push(filename);
  const lockMap: Record<string, string> = { "poetry.lock": "poetry", "Pipfile.lock": "pipenv", "uv.lock": "uv" };
  const lockFiles: string[] = [];
  for (const filename of Object.keys(lockMap)) if (await exists(path.join(projectDir, filename))) lockFiles.push(filename);
  if (dependencyFiles.length === 0 && lockFiles.length === 0) return undefined;

  const managers = new Set(lockFiles.map((name) => lockMap[name]));
  if (dependencyFiles.includes("requirements.txt") || dependencyFiles.includes("requirements-dev.txt")) managers.add("pip");
  if (dependencyFiles.includes("pyproject.toml") && lockFiles.length === 0) managers.add("pyproject");
  const findings: string[] = [];
  if (managers.size > 1) findings.push("Multiple Python package manager inputs found; select the authoritative lockfile.");
  if (lockFiles.length === 0) findings.push("No Python lockfile found; dependency resolution may not be reproducible.");

  let runtimeConstraint: string | null = null;
  const versionPath = path.join(projectDir, ".python-version");
  if (await exists(versionPath)) runtimeConstraint = (await readFile(versionPath, "utf8")).trim() || null;
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  if (await exists(pyprojectPath)) {
    const source = await readFile(pyprojectPath, "utf8");
    const match = source.match(/^requires-python\s*=\s*["']([^"']+)["']/m);
    if (match?.[1]) runtimeConstraint ??= match[1];
  }
  return {
    ecosystem: "python",
    packageManager: managers.size === 1 ? [...managers][0] ?? null : null,
    runtimeConstraint,
    dependencyFiles,
    lockFiles,
    confidence: managers.size > 1 || lockFiles.length === 0 ? "medium" : "high",
    findings,
  };
}

interface PackageMetadata {
  packageManager?: string;
  main?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
}

export async function detectNode(projectDir: string): Promise<EcosystemDetection | undefined> {
  const packagePath = path.join(projectDir, "package.json");
  if (!(await exists(packagePath))) return undefined;
  const metadata = JSON.parse(await readFile(packagePath, "utf8")) as PackageMetadata;
  const lockMap: Record<string, string> = {
    "package-lock.json": "npm",
    "npm-shrinkwrap.json": "npm",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
  };
  const lockFiles: string[] = [];
  for (const filename of Object.keys(lockMap)) if (await exists(path.join(projectDir, filename))) lockFiles.push(filename);
  const managers = new Set(lockFiles.map((name) => lockMap[name]));
  const declared = metadata.packageManager?.split("@")[0];
  const findings: string[] = [];
  if (declared && ["npm", "pnpm", "yarn"].includes(declared)) {
    if (managers.size > 0 && !managers.has(declared)) findings.push(`package.json declares ${declared}, but a different lockfile was found.`);
    managers.add(declared);
  }
  if (new Set(lockFiles.map((name) => lockMap[name])).size > 1) findings.push("Multiple Node.js lockfiles found; select the authoritative lockfile.");
  if (lockFiles.length === 0) findings.push("No Node.js lockfile found; dependency resolution may not be reproducible.");

  const runtimeHints: Array<{ source: string; value: string; priority: number }> = [];
  for (const [filename, priority] of [[".nvmrc", 1], [".node-version", 1]] as const) {
    const candidate = path.join(projectDir, filename);
    if (await exists(candidate)) {
      const value = (await readFile(candidate, "utf8")).trim();
      if (value) runtimeHints.push({ source: filename, value, priority });
    }
  }
  if (metadata.engines?.node) runtimeHints.push({ source: "package.json engines.node", value: metadata.engines.node, priority: 2 });
  const toolVersions = path.join(projectDir, ".tool-versions");
  if (await exists(toolVersions)) {
    const line = (await readFile(toolVersions, "utf8")).split(/\r?\n/).find((item) => /^nodejs\s+\S+/.test(item.trim()));
    const version = line?.trim().split(/\s+/)[1];
    if (version) runtimeHints.push({ source: ".tool-versions", value: version, priority: 3 });
  }
  for (const filename of ["scripts/prepare-offline.sh", "prepare-offline.sh", "deploy.sh"]) {
    const candidate = path.join(projectDir, filename);
    if (!await exists(candidate)) continue;
    const source = await readFile(candidate, "utf8");
    const match = source.match(/^\s*(?:export\s+)?NODE_VERSION\s*=\s*["']?v?(\d+(?:\.\d+){0,2})/m);
    if (match?.[1]) runtimeHints.push({ source: filename, value: match[1], priority: 4 });
  }
  runtimeHints.sort((a, b) => a.priority - b.priority);
  const runtimeConstraint = runtimeHints[0]?.value ?? null;
  if (runtimeHints.some((hint) => hint.value !== runtimeConstraint)) {
    findings.push(`Node.js runtime hints disagree (${runtimeHints.map((hint) => `${hint.source}: ${hint.value}`).join(", ")}); using ${runtimeHints[0]?.source}.`);
  }
  return {
    ecosystem: "node",
    packageManager: managers.size === 1 ? [...managers][0] ?? null : null,
    runtimeConstraint,
    dependencyFiles: ["package.json"],
    lockFiles,
    confidence: findings.length > 0 ? "medium" : "high",
    findings,
  };
}

export async function detectProject(projectDir: string): Promise<EcosystemDetection[]> {
  const results = await Promise.all([detectPython(projectDir), detectNode(projectDir)]);
  return results.filter((result): result is EcosystemDetection => result !== undefined);
}

export async function inferStartCommand(projectDir: string, detections: EcosystemDetection[]): Promise<string[]> {
  if (detections.some((item) => item.ecosystem === "node")) {
    const metadata = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8")) as PackageMetadata;
    if (metadata.scripts?.start) return ["npm", "start"];
    if (metadata.main) return ["node", metadata.main];
  }
  if (detections.some((item) => item.ecosystem === "python")) {
    for (const filename of ["app.py", "main.py"]) if (await exists(path.join(projectDir, filename))) return ["python", filename];
  }
  return [];
}

export interface DevelopmentServer {
  command: string[];
  port: number | null;
}

export async function inferDevelopmentServer(projectDir: string, detections: EcosystemDetection[], configuredPort?: number | null): Promise<DevelopmentServer> {
  if (!detections.some((item) => item.ecosystem === "node")) return { command: [], port: null };
  const metadata = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8")) as PackageMetadata;
  const script = metadata.scripts?.dev;
  if (!script || !/(?:^|[\s&|])vite(?:\s|$)/.test(script)) return { command: [], port: null };
  const explicitPort = script.match(/(?:--port|-p)\s*(?:=\s*)?(\d+)/)?.[1];
  const port = configuredPort ?? (explicitPort ? Number(explicitPort) : 5173);
  return {
    command: ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", String(port)],
    port,
  };
}

export async function inferBuildCommand(projectDir: string, detections: EcosystemDetection[]): Promise<string[]> {
  if (!detections.some((item) => item.ecosystem === "node")) return [];
  const metadata = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8")) as PackageMetadata;
  const scripts = metadata.scripts ?? {};
  for (const filename of ["deploy.sh", "scripts/deploy.sh", "scripts/prepare-offline.sh"]) {
    const scriptPath = path.join(projectDir, filename);
    if (!await exists(scriptPath)) continue;
    const source = await readFile(scriptPath, "utf8");
    const referenced = [...source.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)].map((match) => match[1]).filter((name): name is string => Boolean(name && scripts[name]));
    if (referenced.length === 1) return ["npm", "run", referenced[0]!];
  }
  return scripts.build ? ["npm", "run", "build"] : [];
}
