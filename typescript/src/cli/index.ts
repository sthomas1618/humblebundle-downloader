#!/usr/bin/env bun
import { Command } from "commander";

import { createSession } from "../auth/session";
import { createClient } from "../api/client";
import { resolveConfig } from "../config";
import { auditLibrary, downloadLibrary } from "../download/downloader";

const program = new Command();

/**
 * Primary CLI entrypoint that wires configuration, session creation, API client setup,
 * and download orchestration. This mirrors the Python CLI flow while providing a
 * Bun-based TypeScript implementation scaffold.
 */
const configureCli = () => {
  program
    .name("hbd-ts")
    .description("Bun-based TypeScript port of humblebundle-downloader");

  const applyCommonOptions = (
    command: Command,
    includeUpdate: boolean,
    includeProgress: boolean,
    includeOffline: boolean,
  ) => {
    command.option("-c, --cookie-file <path>", "Path to cookies.txt");
    command.option(
      "-s, --session-auth <value>",
      "Value of the cookie _simpleauth_sess (wrap in quotes)",
    );
    command.requiredOption("-l, --library-path <path>", "Download directory");
    command.option(
      "-t, --trove",
      "Only check and download Humble Trove content",
      false,
    );
    if (includeUpdate) {
      command.option(
        "-u, --update",
        "Check for updates (still download new products)",
        false,
      );
    }
    command.option(
      "-p, --platform <platform...>",
      "Only get content for specific platforms",
    );
    if (includeProgress) {
      command.option("--progress", "Show per-item progress", false);
    }
    command.option(
      "-e, --exclude <ext...>",
      "File extensions to ignore when downloading",
    );
    command.option(
      "-i, --include <ext...>",
      "Only download files with these extensions",
    );
    command.option(
      "-k, --keys <key...>",
      "Purchase download keys to include",
    );
    if (includeOffline) {
      command.option(
        "--offline",
        "Skip remote metadata lookups when auditing",
        false,
      );
    }
  };

  const validateAuth = (options: {
    cookieFile?: string;
    sessionAuth?: string;
  }) => {
    if (options.cookieFile && options.sessionAuth) {
      program.error(
        "Provide either --cookie-file or --session-auth, not both.",
      );
    }
    if (!options.cookieFile && !options.sessionAuth) {
      program.error("Either --cookie-file or --session-auth is required.");
    }
  };

  applyCommonOptions(program, true, true, false);
  program.action(async (options) => {
    validateAuth(options);

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

  const auditCommand = program
    .command("audit")
    .description("Rebuild the cache from existing files without downloading");
  applyCommonOptions(auditCommand, false, false, true);
  auditCommand.action(async (options) => {
    validateAuth(options);

    const config = resolveConfig({
      cookieFile: options.cookieFile,
      sessionAuth: options.sessionAuth,
      libraryPath: options.libraryPath,
      troveOnly: options.trove,
      platformInclude: options.platform,
      extInclude: options.include,
      extExclude: options.exclude,
      purchaseKeys: options.keys,
      offlineAudit: options.offline,
    });

    const session = await createSession(config);
    const client = createClient(session);

    await auditLibrary({
      client,
      config,
    });
  });
};

configureCli();
program.parse();
