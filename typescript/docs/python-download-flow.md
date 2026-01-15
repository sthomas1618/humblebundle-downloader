# Python downloader flow inventory (for Bun/TS port)

This document captures the current Python download flow and maps each function to the
TypeScript/Bun scaffold so we can implement the port incrementally.

## CLI entrypoint → downloader orchestration

**Python**

- `humblebundle_downloader/cli.py:cli()`
  - Parses CLI args.
  - Instantiates `DownloadLibrary(...)`.
  - Calls `.start()`.

**TypeScript mapping**

- `typescript/src/cli/index.ts`
  - Mirror CLI flags and pass config to download orchestration.
- `typescript/src/download/downloader.ts`
  - Provide a `downloadLibrary()` entrypoint akin to `DownloadLibrary.start()`.

## DownloadLibrary responsibilities (Python → TS mapping)

**Python location:** `humblebundle_downloader/download_library.py`

### Constructor & session setup

- `DownloadLibrary.__init__`
  - Stores config flags (library path, progress, include/exclude filters, platform filter).
  - Creates `requests.Session()`.
  - Loads cookies from `cookies.txt` (MozillaCookieJar) or raw file content.
  - Supports `_simpleauth_sess` value when passed directly.

**TypeScript mapping**

- `typescript/src/config/index.ts`
  - Extend config with `sessionAuth`, `platformInclude`, `extInclude`, `extExclude`, etc.
- `typescript/src/auth/session.ts`
  - Parse cookie file / session cookie value and return a `Session` for API client.

### Start orchestration

- `DownloadLibrary.start`
  - Loads cache from `.cache.json`.
  - Resolves purchase keys from library page when not provided.
  - If `trove`: enumerate trove products and download them.
  - Else: iterate purchase keys and download each order.

**TypeScript mapping**

- `typescript/src/download/downloader.ts`
  - Implement `downloadLibrary()` to mirror the above flow.
  - Add cache load/write support for `.cache.json`.

### Trove flow

- `_get_trove_products`
  - Paginates the trove catalog endpoint until empty response.
- `_process_trove_product`
  - Filters by platform.
  - Checks cache and update mode.
  - Signs download URL (`/api/v1/user/download/sign`) and downloads file.
- `_get_trove_download_url`
  - POST to sign endpoint; handles unauthorized response.

**TypeScript mapping**

- `typescript/src/api/client.ts`
  - Add `getTroveProducts()` and `signTroveDownload()` helpers.
- `typescript/src/download/downloader.ts`
  - `processTroveProduct()` equivalent with cache/rename logic.

### Order / purchase flow

- `_get_purchase_keys`
  - Loads library HTML, parses `#user-home-json-data`, returns `gamekeys`.
- `_process_order_id`
  - Fetches `order/{order_id}?all_tpkds=true`, iterates `subproducts`.
- `_process_product`
  - For each platform and download structure:
    - Direct download URLs.
    - ASMJS playable downloads (HTML + manifest assets).
    - External links (log only).

**TypeScript mapping**

- `typescript/src/api/client.ts`
  - `getLibraryPage()` and `getOrderDetails(orderId)` helpers.
- `typescript/src/download/downloader.ts`
  - Implement `processOrderId()` and `processProduct()` with the same branching:
    - direct file downloads
    - asm.js HTML + manifest asset downloads
    - external link logging

### Cache & download mechanics

- `_load_cache_data`
  - Reads `.cache.json` (or empty object).
- `_update_cache_data`
  - Writes cache after each download.
- `_check_cache_and_download`
  - Checks `update` mode, compares `Last-Modified`.
  - Downloads file; handles missing/404s.
- `_process_download`
  - Renames older file if needed, streams content, cleans on error.
- `_download_file`
  - Stream download with optional progress bar.

**TypeScript mapping**

- `typescript/src/download/downloader.ts`
  - Mirror cache read/write, last-modified checks, rename behavior, and streaming.
- `typescript/src/utils/fs.ts`
  - Utilities for rename, mkdir, safe filename handling.

### Filtering / naming helpers

- `_clean_name`
  - Normalizes titles for folder names.
- `_should_download_platform`
  - Platform include filter.
- `_should_download_file_by_ext`
  - Extension include/exclude filter.

**TypeScript mapping**

- `typescript/src/utils/fs.ts`
  - Implement `cleanName()` or `sanitizeName()` based on `_clean_name`.
- `typescript/src/download/downloader.ts`
  - Implement platform/extension filters.

## Next implementation steps

1. Extend the TS config to include all Python CLI options (session auth, trove, include/exclude, platform filters, purchase keys).
2. Implement session/cookie parsing to match Python semantics.
3. Add API client endpoints for library, order, and trove flows.
4. Port cache/update logic and download streaming (with progress bar).
5. Mirror file naming/rename rules to keep directories identical.
