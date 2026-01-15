import type { AppConfig } from "../config";

/**
 * Session state derived from configuration. This will later include
 * parsed cookie data and any derived auth tokens.
 */
export type Session = {
  cookieFile?: string;
  cookieHeader?: string;
};

/**
 * Create a session object based on the current configuration.
 *
 * @param config - Normalized application configuration.
 */
export const createSession = async (config: AppConfig): Promise<Session> => {
  return {
    cookieFile: config.cookieFile,
  };
};
