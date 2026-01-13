import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Ensure the parent directory for a file path exists.
 */
export const ensureDirectory = async (path: string) => {
  await mkdir(dirname(path), { recursive: true });
};
