import { readFileSync } from "node:fs";

// The offline builder embeds this value so the portable CLI needs no package.json.
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
