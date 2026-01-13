import type { Session } from "../auth/session";

/**
 * Contract for API access helpers.
 */
export type ApiClient = {
  session: Session;
  fetchJson: <T>(url: string) => Promise<T>;
};

/**
 * Build an API client instance that can be expanded with authenticated
 * requests once cookie handling is implemented.
 */
export const createClient = (session: Session): ApiClient => {
  const fetchJson = async <T>(url: string): Promise<T> => {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "humblebundle-downloader-ts",
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  };

  return {
    session,
    fetchJson,
  };
};
