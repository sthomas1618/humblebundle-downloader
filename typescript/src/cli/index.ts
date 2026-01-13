#!/usr/bin/env bun
import { Command } from "commander";

import { createSession } from "../auth/session";
import { createClient } from "../api/client";
import { resolveConfig } from "../config";
import { downloadLibrary } from "../download/downloader";

const program = new Command();

/**
 * Primary CLI entrypoint that wires configuration, session creation, API client setup,
 * and download orchestration. This mirrors the Python CLI flow while providing a
 * Bun-based TypeScript implementation scaffold.
 */
const configureCli = () => {
  program
    .name("hbd-ts")
    .description("Bun-based TypeScript port of humblebundle-downloader")
    .option("--cookie-file <path>", "Path to cookies.txt")
    .option("--library-path <path>", "Download directory", "Downloaded Library")
    .option("--progress", "Show per-item progress", false)
    .option("--update", "Only check for updates", false)
    .action(async (options) => {
      const config = resolveConfig({
        cookieFile: options.cookieFile,
        libraryPath: options.libraryPath,
        showProgress: options.progress,
        updateOnly: options.update,
      });

      const session = await createSession(config);
      const client = createClient(session);

      await downloadLibrary({
        client,
        config,
      });
    });
};

configureCli();
program.parse();
