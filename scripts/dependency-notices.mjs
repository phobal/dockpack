import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function dependencyNotices(inputs, root) {
  const packages = new Map();
  for (const input of Object.keys(inputs).filter(name => name.replaceAll("\\", "/").includes("node_modules/"))) {
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== root && directory !== path.dirname(directory)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        if (!manifest.name) { directory = path.dirname(directory); continue; }
        if (!packages.has(manifest.name)) {
          const licenses = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)([._-].*)?$/i.test(name)).sort();
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
