# Humble Bundle Downloader

**Download all of your content from your Humble Bundle Library!**

The first time this runs it may take a while because it will download everything.
After that it will only download the content that has been updated or is missing.

## Features

- support for Humble Trove _(`--trove` flag)_
- downloads new and updated content from your Humble Bundle Library on each run _(only check for updates if using `--update`)_
- cli command for easy use (downloading will also work on a headless system)
- works for SSO and 2FA accounts
- optional progress bar for each item downloaded _(`--progress` flag)_
- optional filter by file types using an include _or_ exclude list _(`--include/--exclude` flag)_
- optional filter by platform types like video, ebook, etc... _(`--platform` flag)_
- audit an existing library to rebuild the cache _(`hbd audit`)_

## Instructions

### 1. Getting cookies

First thing to do is get your account cookies.
This can be done by getting a browser extension that lets you see or export your cookies.

- **Method 1 (recommended)**
  - Get the value of the cookie called `_simpleauth_sess` and pass that value using `-s 'COOKIE_VALUE'`
  - Note: The quotes in the cookie value are part of the value, you might need to wrap the entire value
    (including double quotes) in single quotes. Some suggestions for common issues can be found in [issue #50](https://github.com/xtream1101/humblebundle-downloader/issues/50)

- **Method 2**
  - Export the cookies in the Netscape format using an extension.
    If your exported cookie file is not working, it may be a formatting issue.
    This can be fixed by running the command `curl -b cookies.orig.txt --cookie-jar cookies.txt http://bogus`

### 2. Downloading your library

Use the following command to download your Humble Bundle Library:
`hbd --cookie-file cookies.txt --library-path "Downloaded Library" --progress`

This directory structure will be used:
`Downloaded Library/Purchase Name/Item Name/downloaded_file.ext`

### 3. Auditing an existing library

If you already have a library downloaded but the cache file is missing or stale,
you can rebuild it without downloading anything:
`hbd audit --cookie-file cookies.txt --library-path "Downloaded Library"`
_To skip remote metadata lookups, add `--offline`_

This scans your existing files, compares them against your Humble Bundle
purchases, and updates `.cache.json` so future downloads only fetch missing or
updated content.

## Notes

- Inside your library folder a file named `.cache.json` is saved and keeps track of the files that have been downloaded.
  This way running the download command again pointing to the same directory will only download new or updated files.
- The `.cache.json` file lives at the root of your library directory and stores a JSON object keyed by download identifiers.
  Humble Trove entries use `trove:<web_name>` keys, while bundle/library downloads use `<order_id>:<filename>` keys.
  Trove entries store `uploaded_at` and `md5`, and standard downloads store `url_last_modified` (from the HTTP
  Last-Modified header or set to the current time if missing). Example:

  ```json
  {
    "trove:into_the_breach": {
      "uploaded_at": "2018-02-27T00:00:00Z",
      "md5": "4d186321c1a7f0f354b297e8914ab240"
    },
    "ABCDEF123456:game.exe": {
      "url_last_modified": "2024-01-15T12:34:56Z"
    }
  }
  ```

- Use `--help` with all `hbd` commands to see available options
- Find supported platforms for the `--platform` flag by visiting your Humble Bundle Library
  and look under the **Platform** dropdown
- Download select bundles by using the `-k` or `--keys` flag.
  Find these keys by going to your _Purchases_ section,
  click on a products and there should be a `downloads?key=XXXX` in the url.

## TypeScript/Bun port

The TypeScript/Bun port mirrors the Python CLI structure while providing a modular
TypeScript layout that can be incrementally implemented.

### What is implemented

- **CLI entrypoint** that wires config, session creation, API client setup, and download orchestration.
- **Config module** that resolves CLI overrides into a typed `AppConfig`.
- **Session module** that prepares auth/session state from config.
- **API client module** that exposes a typed JSON fetch helper.
- **Download module** with queue, retry, progress, and integrity checks.
- **Filesystem utilities** for Python-aligned naming and path construction.
- **Tests** covering config resolution, path helpers, and download queue retries.

### Module overview

```
src/
  api/        # API clients and request helpers
  auth/       # session/auth handling
  cli/        # CLI entrypoints
  config/     # config resolution and defaults
  download/   # download orchestration
  utils/      # shared utilities
```

### Types

| Type              | Location                     | Purpose                                           |
| ----------------- | ---------------------------- | ------------------------------------------------- |
| `AppConfig`       | `src/config/index.ts`        | Normalized app configuration used across modules. |
| `Session`         | `src/auth/session.ts`        | Session/auth state derived from config.           |
| `ApiClient`       | `src/api/client.ts`          | API client contract and JSON helper.              |
| `DownloadContext` | `src/download/downloader.ts` | Inputs required for download orchestration.       |

### CLI usage

```bash
bun install
bun run hbd --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

Common options mirrored from the Python CLI:

- `-c, --cookie-file <path>`: Path to a Netscape cookie file.
- `-s, --session-auth <value>`: `_simpleauth_sess` cookie value (wrap in quotes).
- `-l, --library-path <path>`: Download directory (required).
- `-t, --trove`: Only download Humble Trove content.
- `-u, --update`: Only check for updates.
- `-p, --platform <platform...>`: Limit content by platform.
- `--progress`: Show per-item progress.
- `-e, --exclude <ext...>`: Ignore file extensions.
- `-i, --include <ext...>`: Only include file extensions.
- `-k, --keys <key...>`: Limit to purchase keys.

To rebuild the cache from existing files without downloading:

```bash
bun run hbd audit --cookie-file cookies.txt --library-path "Downloaded Library"
```

Add `--offline` to skip remote metadata lookups during audit runs.

### PDF → CBZ conversion

The TypeScript CLI includes a `pdf2cbz` command to convert comic PDFs into CBZ archives.
When a PDF changes (mtime/size), the cache entry under `transforms.pdf.cbz` is refreshed and
the CBZ is regenerated.

```bash
bun run hbd pdf2cbz "./library/**/*.pdf"
```

Input resolution accepts a single PDF path, a directory (recursively scanned for PDFs), or
glob patterns containing `*`/`?`. Output defaults to each PDF’s directory with a `.cbz`
extension, or you can pass `--out <dir>` to write CBZs into a specific folder using the
PDF’s basename.

Use `--dry-run` to preview actions without writing CBZs or touching the cache.
If a CBZ is regenerated, any existing `ComicInfo.xml` stored at the archive root is preserved
and re-injected into the new CBZ.

Example workflow:

```bash
# First run: generates CBZs and writes cache entries
bun run hbd pdf2cbz "./library/**/*.pdf"

# Second run: cache hit, skips unchanged PDFs
bun run hbd pdf2cbz "./library/**/*.pdf"

# If the PDF changes: logs regeneration and updates cache
bun run hbd pdf2cbz "./library/**/*.pdf"
```

You can also use the CLI entrypoint directly if you prefer:

```bash
bun run cli --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

To get a pip-style `hbd` command on your PATH with Bun, you can link the package locally:

```bash
bun link
hbd-bun --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

For Node/npm installs, publish the package and install it globally to access `hbd`:

```bash
npm install -g humblebundle-downloader-ts
hbd --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

### Next steps

- Implement purchase/product orchestration for library and trove downloads.
- Wire platform/extension/key filters into the download selection logic.
- Expand tests for API client behavior and CLI integration.
