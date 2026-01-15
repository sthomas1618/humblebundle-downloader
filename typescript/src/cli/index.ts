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
    .option("-c, --cookie-file <path>", "Path to cookies.txt")
    .option(
      "-s, --session-auth <value>",
      "Value of the cookie _simpleauth_sess (wrap in quotes)",
    )
    .requiredOption("-l, --library-path <path>", "Download directory")
    .option("-t, --trove", "Only check and download Humble Trove content", false)
    .option(
      "-u, --update",
      "Check for updates (still download new products)",
      false,
    )
    .option(
      "-p, --platform <platform...>",
      "Only get content for specific platforms",
    )
    .option("--progress", "Show per-item progress", false)
    .option(
      "-e, --exclude <ext...>",
      "File extensions to ignore when downloading",
    )
    .option(
      "-i, --include <ext...>",
      "Only download files with these extensions",
    )
    .option(
      "-k, --keys <key...>",
      "Purchase download keys to include",
    )
    .action(async (options) => {
      if (options.cookieFile && options.sessionAuth) {
        program.error(
          "Provide either --cookie-file or --session-auth, not both.",
        );
      }
      if (!options.cookieFile && !options.sessionAuth) {
        program.error("Either --cookie-file or --session-auth is required.");
      }

      const config = resolveConfig({
        cookieFile: options.cookieFile,
        sessionAuth: options.sessionAuth,
        libraryPath: options.libraryPath,
        troveOnly: options.trove,
        showProgress: options.progress,
        updateOnly: options.update,
        platformInclude: options.platform,
        extInclude: options.include,
        extExclude: options.exclude,
        purchaseKeys: options.keys,
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
