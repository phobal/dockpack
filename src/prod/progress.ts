export async function productionStep<T>(label: string, action: () => T | Promise<T>): Promise<T> {
  const started = Date.now();
  console.log(`[dockpack] ${label}...`);
  try {
    const result = await action();
    console.log(`[dockpack] ✓ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return result;
  } catch (error) {
    console.error(`[dockpack] ✗ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    throw error;
  }
}
