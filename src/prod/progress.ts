import { logger } from "../logger.js";
export async function productionStep<T>(label: string, action: () => T | Promise<T>): Promise<T> {
  const started = Date.now();
  logger.info(`[dockpack] ${label}...`);
  try {
    const result = await action();
    logger.success(`[dockpack] ✓ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return result;
  } catch (error) {
    logger.error(`[dockpack] ✗ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    throw error;
  }
}
