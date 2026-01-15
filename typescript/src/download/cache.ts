import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CacheEntry = {
  urlLastModified?: string;
  uploadedAt?: string;
  md5?: string;
};

export type CacheData = Record<string, CacheEntry>;

const CACHE_FILE = ".cache.json";

export const loadCache = async (libraryPath: string): Promise<CacheData> => {
  try {
    const data = await readFile(join(libraryPath, CACHE_FILE), "utf-8");
    return JSON.parse(data) as CacheData;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    return {};
  }
};

export const saveCache = async (
  libraryPath: string,
  cache: CacheData,
): Promise<void> => {
  const payload = JSON.stringify(cache, null, 2);
  await writeFile(join(libraryPath, CACHE_FILE), payload);
};
