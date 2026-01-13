import type { ApiClient } from "../api/client";
import type { AppConfig } from "../config";

/**
 * Inputs required to orchestrate downloads for the Humble Bundle library.
 */
export type DownloadContext = {
  client: ApiClient;
  config: AppConfig;
};

/**
 * Coordinate the download flow.
 *
 * This is currently a placeholder that will later:
 * - Fetch purchases and product metadata.
 * - Determine which files need to be downloaded.
 * - Stream downloads with retry and integrity checks.
 */
export const downloadLibrary = async ({ client, config }: DownloadContext) => {
  void client;
  void config;

  console.log("Download flow not implemented yet.");
};
