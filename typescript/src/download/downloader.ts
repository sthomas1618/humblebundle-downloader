import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import type { ApiClient } from "../api/client";
import type { AppConfig } from "../config";
import { buildProductFolder, buildTroveFolder, cleanName } from "../utils/fs";
import { loadCache, saveCache, type CacheEntry } from "./cache";

/**
 * Inputs required to orchestrate downloads for the Humble Bundle library.
 */
export type DownloadContext = {
  client: ApiClient;
  config: AppConfig;
};

export type DownloadItem = {
  url: string;
  destination: string;
  label?: string;
  expectedSize?: number;
  expectedMd5?: string;
  cacheKey?: string;
  cacheEntry?: CacheEntry;
  cacheUpdate?: CacheEntry;
};

export type DownloadResult = {
  item: DownloadItem;
  bytesWritten: number;
  attempts: number;
  skipped?: boolean;
  lastModified?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
};

const reportProgress = (label: string, transferred: number, total?: number) => {
  if (typeof total === "number" && total > 0) {
    const barWidth = 50;
    const done = Math.min(barWidth, Math.floor((transferred / total) * barWidth));
    const percent = Math.min(100, Math.round((done / barWidth) * 100));
    const filler = "=".repeat(Math.max(0, done));
    const space = " ".repeat(Math.max(0, barWidth - done));
    process.stdout.write(
      `\r${label} ${percent}% [${filler}${space}]`,
    );
  } else {
    process.stdout.write(`\r${label} ${transferred}`);
  }
};

const downloadToFile = async (
  item: DownloadItem,
  showProgress: boolean,
): Promise<{ bytesWritten: number; skipped?: boolean; lastModified?: string }> => {
  const response = await fetch(item.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${item.url}: ${response.status}`);
  }

  const total = response.headers.get("content-length");
  const totalBytes = total ? Number.parseInt(total, 10) : undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  if (lastModified && item.cacheEntry?.urlLastModified === lastModified) {
    return { bytesWritten: 0, skipped: true, lastModified };
  }

  await mkdir(dirname(item.destination), { recursive: true });
  const output = createWriteStream(item.destination);

  const expectedBytes = item.expectedSize ?? totalBytes;
  const label = item.label ?? item.destination;
  const hash = item.expectedMd5 ? createHash("md5") : null;

  let written = 0;
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`No response body for ${item.url}`);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      written += value.length;
      if (hash) {
        hash.update(value);
      }
      output.write(Buffer.from(value));
      if (showProgress) {
        reportProgress(label, written, totalBytes);
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    output.end(() => resolve());
    output.on("error", reject);
  });

  if (showProgress) {
    process.stdout.write("\n");
  }

  if (typeof expectedBytes === "number" && written < expectedBytes) {
    throw new Error(
      `Incomplete download for ${item.url}: ${written}/${expectedBytes} bytes`,
    );
  }

  if (hash) {
    const digest = hash.digest("hex");
    if (digest !== item.expectedMd5) {
      throw new Error(
        `MD5 mismatch for ${item.url}: expected ${item.expectedMd5}, got ${digest}`,
      );
    }
  }

  return { bytesWritten: written, lastModified };
};

const downloadWithRetry = async (
  item: DownloadItem,
  showProgress: boolean,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<DownloadResult> => {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const outcome = await downloadToFile(item, showProgress);
      return {
        item,
        bytesWritten: outcome.bytesWritten,
        attempts: attempt,
        skipped: outcome.skipped,
        lastModified: outcome.lastModified,
      };
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      const delay = baseDelayMs * attempt;
      await sleep(delay);
    }
  }

  return { item, bytesWritten: 0, attempts: attempt };
};

export const shouldDownloadPlatform = (
  platform: string,
  config: AppConfig,
): boolean => {
  if (!config.platformInclude || config.platformInclude.length === 0) {
    return true;
  }
  const normalized = config.platformInclude.map((value) => value.toLowerCase());
  if (normalized.includes("all")) {
    return true;
  }
  return normalized.includes(platform.toLowerCase());
};

export const shouldDownloadExt = (
  filename: string,
  config: AppConfig,
): boolean => {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (config.extInclude && config.extInclude.length > 0) {
    return config.extInclude.map((value) => value.toLowerCase()).includes(ext);
  }
  if (config.extExclude && config.extExclude.length > 0) {
    return !config.extExclude.map((value) => value.toLowerCase()).includes(ext);
  }
  return true;
};

const getFilenameFromUrl = (url: string): string => {
  const withoutQuery = url.split("?")[0] ?? url;
  const parts = withoutQuery.split("/");
  return parts[parts.length - 1] ?? cleanName(url);
};

type AsmManifest = Record<string, string>;

const parseAsmPlayerData = (html: string): AsmManifest | null => {
  const match = html.match(
    /id=["']webpack-asm-player-data["'][^>]*>([^<]+)<\/[^>]+>/i,
  );

  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as {
      asmOptions?: { manifest?: Record<string, string> };
    };
    return parsed.asmOptions?.manifest ?? null;
  } catch {
    return null;
  }
};

const writeLocalAsmHtml = async (
  localPath: string,
  html: string,
  manifest: AsmManifest,
): Promise<void> => {
  let output = html;
  for (const [localFilename, remoteFile] of Object.entries(manifest)) {
    output = output.replaceAll(
      `"${localFilename}": "${remoteFile}"`,
      `"${localFilename}": "${localFilename}"`,
    );
  }

  await writeFile(localPath, output);
};

export const formatExternalLinkMessage = (
  bundleTitle: string,
  productTitle: string,
  url: string,
): string =>
  `External link found: ${bundleTitle}/${productTitle} : ${url}`;

export const buildTroveDownloadItems = async (
  products: Awaited<ReturnType<ApiClient["getTroveProducts"]>>,
  config: AppConfig,
  cache: Record<string, CacheEntry>,
  signDownload: ApiClient["signTroveDownload"],
): Promise<DownloadItem[]> => {
  const items: DownloadItem[] = [];

  for (const product of products) {
    const title = cleanName(product["human-name"]);
    const productFolder = buildTroveFolder(config.libraryPath, title);

    for (const [platform, download] of Object.entries(product.downloads)) {
      if (!shouldDownloadPlatform(platform, config)) {
        continue;
      }

      const filename = getFilenameFromUrl(download.url.web);
      if (!shouldDownloadExt(filename, config)) {
        continue;
      }

      const cacheKey = `trove:${filename}`;
      const cacheEntry = cache[cacheKey];
      const uploadedAt =
        download.uploaded_at ?? download.timestamp ?? product.date_added ?? "0";
      const md5 = download.md5 ?? "UNKNOWN_MD5";
      if (cacheEntry && !config.updateOnly) {
        continue;
      }
      if (
        cacheEntry &&
        config.updateOnly &&
        (cacheEntry.uploadedAt === uploadedAt || cacheEntry.md5 === md5)
      ) {
        continue;
      }

      const sign = await signDownload(download.machine_name, filename);
      if (sign._errors === "Unauthorized") {
        throw new Error("Your account does not have access to the Trove.");
      }
      if (!sign.signed_url) {
        continue;
      }

      items.push({
        url: sign.signed_url,
        destination: join(productFolder, filename),
        label: filename,
        expectedMd5: md5,
        cacheKey,
        cacheEntry,
        cacheUpdate: {
          uploadedAt,
          md5,
        },
      });
    }
  }

  return items;
};

export const downloadQueue = async (
  items: DownloadItem[],
  showProgress: boolean,
): Promise<DownloadResult[]> => {
  const results: DownloadResult[] = [];

  for (const item of items) {
    const result = await downloadWithRetry(item, showProgress);
    results.push(result);
  }

  return results;
};

/**
 * Coordinate the download flow.
 *
 * This currently exercises the download queue and integrity checks while the
 * purchase/product orchestration is still being ported.
 */
export const parsePurchaseKeysFromLibraryPage = (html: string): string[] => {
  const match = html.match(
    /id=["']user-home-json-data["'][^>]*>([^<]+)<\/[^>]+>/i,
  );

  if (!match) {
    return [];
  }

  const jsonText = match[1]?.trim();
  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText) as { gamekeys?: string[] };
    return Array.isArray(parsed.gamekeys) ? parsed.gamekeys : [];
  } catch {
    return [];
  }
};

export const downloadLibrary = async ({ client, config }: DownloadContext) => {
  const cache = await loadCache(config.libraryPath);
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage());

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error("Unable to determine purchase keys from the library page.");
  }

  const items: DownloadItem[] = [];

  if (config.troveOnly) {
    const troveProducts = await client.getTroveProducts();
    items.push(
      ...(await buildTroveDownloadItems(
        troveProducts,
        config,
        cache,
        client.signTroveDownload,
      )),
    );
  } else {
    for (const orderId of purchaseKeys) {
      const order = await client.getOrderDetails(orderId);
      const bundleTitle = order.product.human_name;

      for (const product of order.subproducts) {
        const productFolder = buildProductFolder(
          config.libraryPath,
          bundleTitle,
          product.human_name,
        );

        for (const downloadType of product.downloads) {
          if (!shouldDownloadPlatform(downloadType.platform, config)) {
            continue;
          }

          for (const fileType of downloadType.download_struct) {
            if (fileType.url?.web) {
              const filename = getFilenameFromUrl(fileType.url.web);
              if (!shouldDownloadExt(filename, config)) {
                continue;
              }

              const cacheKey = `${orderId}:${filename}`;
              const cacheEntry = cache[cacheKey];
              if (cacheEntry && !config.updateOnly) {
                continue;
              }

              items.push({
                url: fileType.url.web,
                destination: join(productFolder, filename),
                label: filename,
                expectedSize: fileType.file_size,
                expectedMd5: fileType.md5,
                cacheKey,
                cacheEntry,
              });
              continue;
            }

            if (fileType.external_link) {
              console.info(
                formatExternalLinkMessage(
                  bundleTitle,
                  product.human_name,
                  fileType.external_link,
                ),
              );
              continue;
            }

            if (fileType.asm_config) {
              const gameName = fileType.asm_config.display_item;
              const asmFile = fileType.asm_manifest?.asmFile;
              if (!gameName || !asmFile) {
                console.info(
                  `ASM.js content missing metadata: ${bundleTitle}/${product.human_name}`,
                );
                continue;
              }

              const localFolder = join(productFolder, gameName);
              await mkdir(localFolder, { recursive: true });

              const asmFilename = `${gameName}.html`;
              const asmLocalFilename = `${gameName}.local.html`;
              const asmCacheKey = `${orderId}:${asmFilename}`;
              const asmCacheEntry = cache[asmCacheKey];

              let html = "";
              let lastModified: string | undefined;
              if (asmCacheEntry && !config.updateOnly) {
                try {
                  html = await readFile(join(localFolder, asmFilename), "utf-8");
                } catch {
                  html = "";
                }
              }

              if (!html) {
                const gameAsmName = asmFile.split("/")[2] ?? asmFile;
                const asmUrl = `https://www.humblebundle.com/play/asmjs/${gameAsmName}/${orderId}`;
                const response = await fetch(asmUrl);
                if (!response.ok) {
                  console.info(
                    `Failed to download ASM.js HTML: ${bundleTitle}/${product.human_name}`,
                  );
                  continue;
                }
                lastModified = response.headers.get("last-modified") ?? undefined;
                html = await response.text();
                await writeFile(join(localFolder, asmFilename), html);
                cache[asmCacheKey] = {
                  urlLastModified: lastModified ?? new Date().toUTCString(),
                };
              }

              const manifest = parseAsmPlayerData(html);
              if (!manifest) {
                console.info(
                  `ASM.js manifest missing: ${bundleTitle}/${product.human_name}`,
                );
                continue;
              }

              await writeLocalAsmHtml(
                join(localFolder, asmLocalFilename),
                html,
                manifest,
              );

              for (const [localFilename, remoteFile] of Object.entries(manifest)) {
                const cacheKey = `${orderId}:${gameName}:${localFilename}`;
                const cacheEntry = cache[cacheKey];
                if (cacheEntry && !config.updateOnly) {
                  continue;
                }

                items.push({
                  url: remoteFile,
                  destination: join(localFolder, localFilename),
                  label: localFilename,
                  cacheKey,
                  cacheEntry,
                });
              }
            }
          }
        }
      }
    }
  }

  const results = await downloadQueue(items, config.showProgress);

  for (const result of results) {
    const cacheKey = result.item.cacheKey;
    if (!cacheKey || result.skipped) {
      continue;
    }

    const cacheUpdate = result.item.cacheUpdate ?? {};
    const lastModified =
      result.lastModified ?? new Date().toUTCString();

    cache[cacheKey] = {
      ...cacheUpdate,
      urlLastModified: cacheUpdate.urlLastModified ?? lastModified,
    };
  }

  await saveCache(config.libraryPath, cache);

  return {
    processed: results.length,
  };
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const fetchLastModified = async (
  client: ApiClient,
  url: string,
): Promise<string | undefined> => {
  const headers = new Headers();
  headers.set("User-Agent", "humblebundle-downloader-ts");
  if (client.session.cookieHeader) {
    headers.set("cookie", client.session.cookieHeader);
  }

  const response = await fetch(url, { method: "HEAD", headers });
  if (!response.ok) {
    return undefined;
  }
  return response.headers.get("last-modified") ?? undefined;
};

const auditCacheEntry = async (
  cache: Record<string, CacheEntry>,
  cacheKey: string,
  localPath: string,
  metadata: CacheEntry,
): Promise<void> => {
  if (!(await fileExists(localPath))) {
    return;
  }
  cache[cacheKey] = metadata;
};

export const auditLibrary = async ({ client, config }: DownloadContext) => {
  const cache = await loadCache(config.libraryPath);
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage());

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error("Unable to determine purchase keys from the library page.");
  }

  const now = new Date().toUTCString();

  if (config.troveOnly) {
    const troveProducts = await client.getTroveProducts();
    for (const product of troveProducts) {
      const title = cleanName(product["human-name"]);
      const productFolder = buildTroveFolder(config.libraryPath, title);

      for (const [platform, download] of Object.entries(product.downloads)) {
        if (!shouldDownloadPlatform(platform, config)) {
          continue;
        }

        const filename = getFilenameFromUrl(download.url.web);
        if (!shouldDownloadExt(filename, config)) {
          continue;
        }

        const cacheKey = `trove:${filename}`;
        const uploadedAt =
          download.uploaded_at ?? download.timestamp ?? product.date_added ?? "0";
        const md5 = download.md5 ?? "UNKNOWN_MD5";
        const localPath = join(productFolder, filename);

        await auditCacheEntry(cache, cacheKey, localPath, {
          uploadedAt,
          md5,
        });
      }
    }
  } else {
    for (const orderId of purchaseKeys) {
      const order = await client.getOrderDetails(orderId);
      const bundleTitle = order.product.human_name;

      for (const product of order.subproducts) {
        const productFolder = buildProductFolder(
          config.libraryPath,
          bundleTitle,
          product.human_name,
        );

        for (const downloadType of product.downloads) {
          if (!shouldDownloadPlatform(downloadType.platform, config)) {
            continue;
          }

          for (const fileType of downloadType.download_struct) {
            if (fileType.url?.web) {
              const filename = getFilenameFromUrl(fileType.url.web);
              if (!shouldDownloadExt(filename, config)) {
                continue;
              }

              const cacheKey = `${orderId}:${filename}`;
              const localPath = join(productFolder, filename);
              if (!(await fileExists(localPath))) {
                continue;
              }
              const lastModified = config.offlineAudit
                ? undefined
                : await fetchLastModified(client, fileType.url.web);

              cache[cacheKey] = {
                urlLastModified: lastModified ?? now,
              };
              continue;
            }

            if (fileType.asm_config) {
              const gameName = fileType.asm_config.display_item;
              const asmFile = fileType.asm_manifest?.asmFile;
              if (!gameName || !asmFile) {
                continue;
              }

              const localFolder = join(productFolder, gameName);
              const asmFilename = `${gameName}.html`;
              const asmLocalFilename = `${gameName}.local.html`;
              const asmCacheKey = `${orderId}:${asmFilename}`;
              const asmPath = join(localFolder, asmFilename);
              if (await fileExists(asmPath)) {
                const lastModified = config.offlineAudit
                  ? undefined
                  : await fetchLastModified(
                      client,
                      `https://www.humblebundle.com/play/asmjs/${asmFile.split("/")[2] ?? asmFile}/${orderId}`,
                    );
                cache[asmCacheKey] = {
                  urlLastModified: lastModified ?? now,
                };
              }

              let html = "";
              if (await fileExists(asmPath)) {
                html = await readFile(asmPath, "utf-8");
              } else {
                const localHtmlPath = join(localFolder, asmLocalFilename);
                if (await fileExists(localHtmlPath)) {
                  html = await readFile(localHtmlPath, "utf-8");
                }
              }

              const manifest = html ? parseAsmPlayerData(html) : null;
              if (!manifest) {
                continue;
              }

              for (const [localFilename, remoteFile] of Object.entries(manifest)) {
                const cacheKey = `${orderId}:${gameName}:${localFilename}`;
                const localPath = join(localFolder, localFilename);
                if (!(await fileExists(localPath))) {
                  continue;
                }
                const fileLastModified = config.offlineAudit
                  ? undefined
                  : await fetchLastModified(client, remoteFile);
                cache[cacheKey] = {
                  urlLastModified: fileLastModified ?? now,
                };
              }
            }
          }
        }
      }
    }
  }

  await saveCache(config.libraryPath, cache);
};
