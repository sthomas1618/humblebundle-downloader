/**
 * Normalized app configuration used across modules.
 */
export type AppConfig = {
  /** Path to a Netscape-format cookie file used for authentication. */
  cookieFile?: string;
  /** Root directory where downloads are stored. */
  libraryPath: string;
  /** Whether to show per-item progress indicators. */
  showProgress: boolean;
  /** Whether to only check for updates instead of full download. */
  updateOnly: boolean;
};

type ConfigOverrides = {
  cookieFile?: string;
  libraryPath?: string;
  showProgress?: boolean;
  updateOnly?: boolean;
};

/**
 * Resolve CLI and environment overrides into a full AppConfig object.
 */
export const resolveConfig = (overrides: ConfigOverrides): AppConfig => {
  return {
    cookieFile: overrides.cookieFile,
    libraryPath: overrides.libraryPath ?? "Downloaded Library",
    showProgress: overrides.showProgress ?? false,
    updateOnly: overrides.updateOnly ?? false,
  };
};
