/**
 * Normalized app configuration used across modules.
 */
export type AppConfig = {
  /** Path to a Netscape-format cookie file used for authentication. */
  cookieFile?: string;
  /** Raw value of the `_simpleauth_sess` cookie when provided directly. */
  sessionAuth?: string;
  /** Root directory where downloads are stored. */
  libraryPath: string;
  /** Only download Humble Trove content. */
  troveOnly: boolean;
  /** Whether to show per-item progress indicators. */
  showProgress: boolean;
  /** Whether to only check for updates instead of full download. */
  updateOnly: boolean;
  /** Limit downloads to specific platforms. */
  platformInclude?: string[];
  /** Only download files with these extensions. */
  extInclude?: string[];
  /** Exclude files with these extensions. */
  extExclude?: string[];
  /** Only download items from specific purchase keys. */
  purchaseKeys?: string[];
  /** Skip remote metadata lookups during audit. */
  offlineAudit: boolean;
};

type ConfigOverrides = {
  cookieFile?: string;
  sessionAuth?: string;
  libraryPath?: string;
  troveOnly?: boolean;
  showProgress?: boolean;
  updateOnly?: boolean;
  platformInclude?: string[];
  extInclude?: string[];
  extExclude?: string[];
  purchaseKeys?: string[];
  offlineAudit?: boolean;
};

/**
 * Resolve CLI and environment overrides into a full AppConfig object.
 */
export const resolveConfig = (overrides: ConfigOverrides): AppConfig => {
  const normalize = (values?: string[]): string[] | undefined =>
    values?.map((value) => value.toLowerCase());

  return {
    cookieFile: overrides.cookieFile,
    sessionAuth: overrides.sessionAuth,
    libraryPath: overrides.libraryPath ?? "Downloaded Library",
    troveOnly: overrides.troveOnly ?? false,
    showProgress: overrides.showProgress ?? false,
    updateOnly: overrides.updateOnly ?? false,
    platformInclude: normalize(overrides.platformInclude),
    extInclude: normalize(overrides.extInclude),
    extExclude: normalize(overrides.extExclude),
    purchaseKeys: overrides.purchaseKeys,
    offlineAudit: overrides.offlineAudit ?? false,
  };
};
