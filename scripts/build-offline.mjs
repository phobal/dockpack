import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { unzipSync, zipSync } from "fflate";
import * as tar from "tar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const runtime = JSON.parse(await readFile(new URL("./offline-runtime.json", import.meta.url), "utf8"));
const { values } = parseArgs({ options: {
  target: { type: "string", default: "all" },
  output: { type: "string", default: path.join(root, "release") },
  help: { type: "boolean", default: false },
} });
if (values.help) {
  console.log(`Usage: npm run build:offline -- [--target all|${Object.keys(runtime.targets).join("|")}] [--output <directory>]`);
  process.exit(0);
}
const targets = values.target === "all" ? Object.keys(runtime.targets) : [values.target];
if (targets.some(target => !Object.hasOwn(runtime.targets, target))) {
  throw new Error(`Unsupported CLI host target: ${values.target}`);
}
const output = path.resolve(values.output);
const cache = path.join(root, ".offline-cache");
const staging = path.join(root, ".offline-build");
await Promise.all([mkdir(output, { recursive: true }), mkdir(cache, { recursive: true }), mkdir(staging, { recursive: true })]);
const work = await mkdtemp(path.join(staging, "build-"));

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function fetchRuntime(spec) {
  const cached = path.join(cache, spec.archive);
  try {
    if (await sha256(cached) !== spec.sha256) throw new Error(`Runtime cache checksum mismatch. Remove ${cached} and retry.`);
    return cached;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const url = `${runtime.baseUrl}/v${runtime.version}/${spec.archive}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Node.js download failed: HTTP ${response.status} (${url})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256) {
    throw new Error(`Node.js checksum mismatch: ${spec.archive}`);
  }
  const temporary = path.join(work, spec.archive);
  await writeFile(temporary, bytes);
  await rename(temporary, cached);
  return cached;
}

async function filesIn(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(path.join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unexpected non-regular distribution member: ${name}`);
  }
  return files.sort();
}

async function dependencyNotices(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs).filter(name => name.replaceAll("\\", "/").includes("node_modules/"))) {
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== root && directory !== path.dirname(directory)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        if (!manifest.name) { directory = path.dirname(directory); continue; }
        if (!packages.has(manifest.name)) {
          const licenses = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(\..*)?$/i.test(name)).sort();
          if (!licenses.length) throw new Error(`Missing license text for bundled dependency: ${manifest.name}`);
          const text = await Promise.all(licenses.map(name => readFile(path.join(directory, name), "utf8")));
          packages.set(manifest.name, `${manifest.name}@${manifest.version}\n${text.join("\n")}`);
        }
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        directory = path.dirname(directory);
      }
    }
  }
  return [...packages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join("\n\n--------------------\n\n");
}

function posixLauncher(target) {
  const [platform, arch] = target.split("-");
  const machine = arch === "x64" ? "x86_64" : platform === "darwin" ? "arm64" : "aarch64";
  const expected = `${platform === "darwin" ? "Darwin" : "Linux"}:${machine}`;
  return `#!/bin/sh
set -eu
if [ "$(uname -s):$(uname -m)" != "${expected}" ]; then
  echo "dockpack: this runtime package requires ${target}. Transfer the package matching this host OS and CPU." >&2
  exit 1
fi
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -x "$base/runtime/node" ]; then
  echo "dockpack: bundled Node.js is missing or not executable. Extract the complete runtime package again." >&2
  exit 1
fi
exec "$base/runtime/node" "$base/app/dockpack.cjs" "$@"
`;
}

const windowsLauncher = `@echo off
setlocal
if /I not "%PROCESSOR_ARCHITECTURE%"=="AMD64" if /I not "%PROCESSOR_ARCHITEW6432%"=="AMD64" (
  echo dockpack: this runtime package requires Windows x64. 1>&2
  exit /b 1
)
if not exist "%~dp0runtime\\node.exe" (
  echo dockpack: bundled Node.js is missing. Extract the complete runtime package again. 1>&2
  exit /b 1
)
"%~dp0runtime\\node.exe" "%~dp0app\\dockpack.cjs" %*
exit /b %errorlevel%
`.replaceAll("\n", "\r\n");

try {
  const bundled = path.join(work, "dockpack.cjs");
  const result = await build({
    absWorkingDir: root, entryPoints: ["src/cli.ts"], outfile: bundled,
    bundle: true, platform: "node", format: "cjs", target: "node24",
    sourcemap: false, metafile: true, legalComments: "inline",
    plugins: [{
      name: "embed-package-version",
      setup(build) {
        build.onLoad({ filter: /[/\\]src[/\\]version\.ts$/ }, () => ({
          contents: `export const VERSION = ${JSON.stringify(pkg.version)};`, loader: "js",
        }));
      },
    }],
  });
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  for (const artifact of Object.values(result.metafile.outputs)) {
    for (const imported of artifact.imports) {
      if (imported.external && !builtins.has(imported.path)) throw new Error(`Unbundled runtime dependency: ${imported.path}`);
    }
  }
  const notices = await dependencyNotices(result.metafile.inputs);
  for (const target of targets) {
    console.log(`Packaging dockpack ${pkg.version} for ${target} (Node.js ${runtime.version})`);
    const spec = runtime.targets[target];
    const windows = target.startsWith("win32-");
    const name = `dockpack-cli-${pkg.version}-${target}`;
    const directory = path.join(work, name);
    await mkdir(path.join(directory, "app"), { recursive: true });
    await mkdir(path.join(directory, "runtime"), { recursive: true });
    const source = await fetchRuntime(spec);
    const nodeRoot = spec.archive.replace(/\.(tar\.gz|zip)$/, "");
    const executable = windows ? "node.exe" : "bin/node";
    const wanted = [`${nodeRoot}/${executable}`, `${nodeRoot}/LICENSE`];
    const unpacked = path.join(work, `node-${target}`);
    await mkdir(unpacked);
    if (windows) {
      const entries = unzipSync(await readFile(source), { filter: entry => wanted.includes(entry.name) });
      for (const member of wanted) {
        if (!entries[member]) throw new Error(`Node archive is missing ${member}`);
        await writeFile(path.join(unpacked, path.basename(member)), entries[member]);
      }
    } else {
      await tar.extract({ file: source, cwd: unpacked, strict: true,
        filter: (name, entry) => wanted.includes(name) && entry.type === "File" });
      await copyFile(path.join(unpacked, nodeRoot, "bin/node"), path.join(unpacked, "node"));
      await copyFile(path.join(unpacked, nodeRoot, "LICENSE"), path.join(unpacked, "LICENSE"));
    }
    const nodeName = windows ? "node.exe" : "node";
    await copyFile(path.join(unpacked, nodeName), path.join(directory, "runtime", nodeName));
    await chmod(path.join(directory, "runtime", nodeName), 0o755);
    await copyFile(path.join(unpacked, "LICENSE"), path.join(directory, "LICENSE-Node.txt"));
    await copyFile(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
    await copyFile(bundled, path.join(directory, "app", "dockpack.cjs"));
    await writeFile(path.join(directory, "THIRD-PARTY-NOTICES.txt"), notices);
    const launcher = windows ? "dockpack.cmd" : "dockpack";
    await writeFile(path.join(directory, launcher), windows ? windowsLauncher : posixLauncher(target), { mode: 0o755 });
    await writeFile(path.join(directory, "runtime.json"), JSON.stringify({
      dockpack_version: pkg.version, cli_platform: target, node_version: runtime.version,
      supported_bundle_schemas: [1], node_archive: spec.archive,
      node_source: `${runtime.baseUrl}/v${runtime.version}/${spec.archive}`, node_sha256: spec.sha256,
    }, null, 2) + "\n");
    await writeFile(path.join(directory, "README.txt"),
      `dockpack ${pkg.version} 离线运行包 (${target})\n\n` +
      `完整解压后，在此目录执行 ${windows ? ".\\dockpack.cmd" : "./dockpack"} --help。\n` +
      `此包自带 Node.js ${runtime.version} 和 CLI 依赖，无需 npm install。\n` +
      `例如：${windows ? ".\\dockpack.cmd" : "./dockpack"} dev init <项目目录> --bundle <开发包路径>\n` +
      "项目源代码和项目离线包需要另行传输。Docker CLI、daemon 和 Compose 需要预先安装。\n" +
      "可以将此目录加入 PATH；请保留整个目录结构，不要只复制启动器。\n" +
      "checksums.sha256 用于核对解压后的文件；归档旁的 .sha256 文件用于核对归档。\n" +
      "系统要求：Linux x64/arm64 内核 >= 4.18、glibc >= 2.28；Windows x64 >= Windows 10/Server 2016；macOS >= 13.5。\n" +
      `Linux 运行包不支持 Alpine/musl。Node.js 平台要求见 https://github.com/nodejs/node/blob/v${runtime.version}/BUILDING.md#platform-list\n`);
    const members = await filesIn(directory);
    const hashes = await Promise.all(members.map(async file => `${await sha256(path.join(directory, file))}  ${file}`));
    await writeFile(path.join(directory, "checksums.sha256"), hashes.join("\n") + "\n");
    members.push("checksums.sha256");
    const filename = `${name}.${windows ? "zip" : "tar.gz"}`;
    const archive = path.join(work, filename);
    if (windows) {
      const entries = {};
      for (const file of members) entries[`${name}/${file}`] = [await readFile(path.join(directory, file)), { mtime: new Date("2000-01-01T00:00:00Z") }];
      await writeFile(archive, zipSync(entries, { level: 6 }));
    } else {
      await tar.create({ file: archive, cwd: work, gzip: true, portable: true,
        mtime: new Date("2000-01-01T00:00:00Z"),
        onWriteEntry(entry) {
          // Windows file modes cannot express executable bits; set tar modes explicitly.
          entry.stat.mode = entry.path === `${name}/dockpack` || entry.path === `${name}/runtime/node` ? 0o755 : 0o644;
        },
      }, members.map(file => `${name}/${file}`));
    }
    const hash = await sha256(archive);
    const publishStage = await mkdtemp(path.join(output, ".dockpack-"));
    try {
      // Copy first so --output also works on a different filesystem.
      await copyFile(archive, path.join(publishStage, filename));
      await writeFile(path.join(publishStage, `${filename}.sha256`), `${hash}  ${filename}\n`);
      await rename(path.join(publishStage, filename), path.join(output, filename));
      await rename(path.join(publishStage, `${filename}.sha256`), path.join(output, `${filename}.sha256`));
    } finally {
      await rm(publishStage, { recursive: true, force: true });
    }
    console.log(`Created ${path.join(output, filename)}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
