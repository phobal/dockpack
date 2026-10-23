import figlet from "figlet/browser";
import standard from "figlet/fonts/Standard";
import { logger } from "./logger.js";

export function printBanner(): void {
  // Embed the font so standalone offline bundles need no external font files.
  figlet.parseFont("Standard", standard);
  logger.info(`\n${figlet.textSync("Dockpack", { font: "Standard" })}\n`);
}
