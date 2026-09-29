import { constants } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { validateConfig, type DockpackConfig } from "./schema.js";
import { DockpackError } from "../errors.js";

export const CONFIG_FILE = ".dockpack.yaml";

export async function readConfig(filePath: string): Promise<DockpackConfig> {
  try {
    const text = await readFile(filePath, "utf8");
    return validateConfig(parse(text));
  } catch (error) {
    if (error instanceof DockpackError) throw error;
    throw new DockpackError(`Cannot read or validate ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function createConfigOnce(projectDir: string, config: DockpackConfig): Promise<boolean> {
  const filePath = path.join(projectDir, CONFIG_FILE);
  const content = `# Dockpack project configuration. Review and edit as needed.\n${stringify(config)}`;
  try {
    const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new DockpackError(`Cannot create ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function configExists(projectDir: string): Promise<boolean> {
  try {
    await access(path.join(projectDir, CONFIG_FILE));
    return true;
  } catch {
    return false;
  }
}
