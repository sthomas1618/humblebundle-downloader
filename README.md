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
- validate config, libraries, routing, cache, and auth _(`hbd doctor`)_
- organize existing files into their routed library _(`hbd organize`)_
- remove empty folders left after moves _(`hbd cleanup`)_
- scan additional local library roots before downloading _(`--scan-path` flag)_
- strict JSON config in a hidden media-root folder _(`hbd config init`)_

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
_To skip per-file HEAD metadata checks, add `--offline`; Humble library auth is still required._

This scans your existing files, compares them against your Humble Bundle
purchases, and updates `.cache.json` so future downloads only fetch missing or
updated content. Audit and download also update a URL-free metadata snapshot for
future organization and validation workflows.

If your Humble library is split across multiple local folders, create a shared
config under your media root:

```powershell
bun run hbd config init `
  --media-root "C:\Users\me\Dropbox\Media" `
  --default-library comics `
  --library comics:"Comics\comics" `
  --library books:"Books" `
  --library manga:"Manga"
```

This creates:

```text
C:\Users\me\Dropbox\Media\.hbd\
  config.json
  cache.json
  download-failures.json
  metadata.json
```

When running from inside the media root, the CLI auto-discovers
`.hbd/config.json`. You can also pass `--config <path>` or set `HBD_CONFIG`.
Config lookup uses this order: `--config`, `HBD_CONFIG`, auto-discovery, then
legacy CLI-only behavior.

Configured libraries can use different format preferences. The generated
defaults are:

- `comics`: `cbz`, then `pdf`, then `epub`, then `mobi`
- `manga`: `cbz`, then `pdf`, then `epub`, then `mobi`
- `books`: `epub`, then `pdf`, then `mobi`

When named libraries exist, `config init` also adds routes. Routes are evaluated
per selected download candidate. Earlier routes take precedence, so broad bundle
routes can keep Comic and Manga bundles together, while later product and format
hints still help neutral bundles:

```json
{
  "routes": [
    {
      "id": "manga-bundles",
      "library": "manga",
      "bundleTitlePatterns": ["\\bmanga\\s+bundle\\b"]
    },
    {
      "id": "comic-bundles",
      "library": "comics",
      "bundleTitlePatterns": ["\\bcomics?\\s+bundle\\b"]
    },
    {
      "id": "comic-formats",
      "library": "comics",
      "extensions": ["cbz"]
    },
    {
      "id": "book-bundles",
      "library": "books",
      "bundleTitlePatterns": ["\\b(?:book bundle|ebooks?|e-books?|novels?)\\b"]
    },
    {
      "id": "manga-products",
      "library": "manga",
      "productTitlePatterns": ["\\bmanga\\b"],
      "filenamePatterns": ["\\bmanga\\b"]
    },
    {
      "id": "book-products",
      "library": "books",
      "productTitlePatterns": ["\\b(?:book|ebook|e-book|novel|guide|author)\\b"],
      "filenamePatterns": ["\\b(?:book|ebook|e-book|novel|guide)\\b"]
    },
    {
      "id": "ebook-formats",
      "library": "books",
      "extensions": ["epub", "mobi"]
    }
  ]
}
```

Routing uses config order as precedence. When nothing matches, downloads fall
back to the active/default library.

Run with the default configured library:

```powershell
bun run hbd audit --session-auth "COOKIE_VALUE"
bun run hbd --session-auth "COOKIE_VALUE"
```

Choose a different configured download destination:

```powershell
bun run hbd --library books --session-auth "COOKIE_VALUE"
```

Check the setup before a long audit or download:

```powershell
bun run hbd doctor
bun run hbd doctor --auth --session-auth "COOKIE_VALUE"
bun run hbd doctor --deep --session-auth "COOKIE_VALUE"
```

`doctor` is read-only. The fast check validates config discovery, library paths,
routes, format preferences, cache parsing, legacy cache files, and the failure
report. `--auth` confirms the Humble library page is reachable without printing
secrets. `--deep` fetches Humble metadata and compares the current selected
downloads against cache and disk, reporting routing counts, ambiguous routing,
cached-but-missing files, local uncached files, files in the wrong routed
library, size mismatches, downloads that are not present yet, and cache entries
no longer selected by the current config. Deep checks write a detailed report to
`.hbd/doctor-report.json`.

For slower integrity checks where Humble provides MD5 metadata, add `--hash`:

```powershell
bun run hbd doctor --deep --hash --session-auth "COOKIE_VALUE"
```

Preview moves that would put existing files into the library selected by the
same routing rules used by audit and download:

```powershell
bun run hbd organize
```

`organize` reads `.hbd/metadata.json`, so run `audit` or `download` first after
config changes. It is a dry run by default and only fixes files that are in the
wrong routed library. To actually move files:

```powershell
bun run hbd organize --apply --report-path ".hbd/organize-report.json"
```

Add `--canonical` if you also want files already inside the right library moved
into the standard bundle/product folder layout.

Add `--flat` to organize products into publisher/series folders instead of
bundle/product folders:

```powershell
bun run hbd organize --flat --apply
```

Flat organize infers publishers from bundle titles such as `by O'Reilly` or
`by Image Comics`; products with no inferred publisher are placed under
`humble`. Repeated products across bundles are collapsed, while different file
formats for the same product are kept. When applied from a config-backed run,
configured libraries are marked with `layout: "flat"` so future downloads use
the same structure and skip already satisfied duplicate products.

Preview empty folders that can be removed from configured library roots:

```powershell
bun run hbd cleanup --report-path ".hbd/cleanup-dry-run.json"
```

`cleanup` is a dry run by default. It scans configured library roots, plans
deepest folders first, and never removes the configured root folder itself. To
actually remove empty folders:

```powershell
bun run hbd cleanup --apply --report-path ".hbd/cleanup-report.json"
```

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

- Audit and download write a `metadata.json` snapshot of Humble order titles,
  product titles, filenames, extensions, platforms, sizes, and MD5 values when
  available. Configured runs store it at `.hbd/metadata.json`; CLI-only runs
  default to `<library-path>/.metadata.json`. Signed download URLs and auth
  secrets are not stored.

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
  cleanup/    # empty directory cleanup
  config/     # config resolution and defaults
  download/   # download orchestration
  organize/   # local library organization
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
- `--config <path>`: Path to `.hbd/config.json`.
- `--library <name>`: Configured library to use as the download destination.
- `-l, --library-path <path>`: Download directory; required when no config is loaded.
- `--scan-path <path...>`: Additional directory roots to scan for existing downloads before downloading.
- `--cache-path <path>`: Cache file path; defaults to `<library-path>/.cache.json`.
- `--metadata-path <path>`: Metadata snapshot file path; defaults to `<library-path>/.metadata.json`.
- `hbd doctor`: Validate local setup, cache health, routing, and optional auth/deep metadata checks.
- `hbd organize`: Move existing selected files into the routed library; dry-run by default, use `--apply` to move files. Add `--canonical` to also normalize folder layout inside the same library, or `--flat` to use publisher/series folders and mark config-backed libraries flat on apply.
- `hbd cleanup`: Remove empty folders from configured library roots; dry-run by default, use `--apply` to delete empty folders.
- `-t, --trove`: Only download Humble Trove content.
- `-u, --update`: Only check for updates.
- `-p, --platform <platform...>`: Limit content by platform.
- `--progress`: Show per-item progress.
- `-e, --exclude <ext...>`: Ignore file extensions.
- `-i, --include <ext...>`: Only include file extensions.
- `--format-priority <ext...>`: Prefer file extensions in priority order (default: `cbz, epub, pdf, mobi`); if none are available, download all files for the product. Include/exclude filters apply before format selection.
- `-k, --keys <key...>`: Limit to purchase keys.

To rebuild the cache from existing files without downloading:

```bash
bun run hbd audit --cookie-file cookies.txt --library-path "Downloaded Library"
```

Add `--offline` to skip per-file HEAD metadata checks during audit runs. Audit
still loads your Humble library metadata, so auth is still required.

Config files are strict JSON and intentionally do not store auth secrets. Keep
using `--session-auth` or `--cookie-file` when running commands.

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
